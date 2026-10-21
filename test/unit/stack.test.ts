import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { RailcarOrdersStack, SETTINGS } from "../../lib/railcar-orders-stack";
import { createTableInput } from "../../src/store/table";

function synth(reservedConcurrency = true): Template {
  // Skip esbuild bundling: these tests look at the template, not the code assets.
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new RailcarOrdersStack(app, "Test", { reservedConcurrency, env: { region: "us-east-2" } });
  return Template.fromStack(stack);
}

const template = synth();

type Resource = { Properties: Record<string, unknown>; DeletionPolicy?: string };
const resources = (type: string) => Object.values(template.findResources(type)) as Resource[];

function functionByEntry(name: string): Resource {
  // Function logical ids start with the construct id, e.g. "createorder5D3C0357".
  const compact = name.replace(/-/g, "");
  const match = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) => id.startsWith(compact));
  if (!match) throw new Error(`no function ${name}`);
  return match[1] as Resource;
}

function policyActions(fnName: string): string[] {
  const compact = fnName.replace(/-/g, "");
  const policies = Object.entries(template.findResources("AWS::IAM::Policy")).filter(([id]) => id.startsWith(compact));
  return policies.flatMap(([, p]) =>
    ((p as Resource).Properties.PolicyDocument as { Statement: { Action: string | string[] }[] }).Statement.flatMap(
      (s) => (Array.isArray(s.Action) ? s.Action : [s.Action]),
    ),
  );
}

describe("API", () => {
  it("requires an API key on every method", () => {
    const methods = resources("AWS::ApiGateway::Method");
    expect(methods).toHaveLength(3);
    for (const m of methods) expect(m.Properties.ApiKeyRequired).toBe(true);
  });

  it("puts the key on a usage plan with a throttle and a daily quota", () => {
    template.hasResourceProperties("AWS::ApiGateway::UsagePlan", {
      Throttle: { RateLimit: SETTINGS.apiRateLimitPerSecond, BurstLimit: SETTINGS.apiBurstLimit },
      Quota: { Limit: SETTINGS.apiDailyQuota, Period: "DAY" },
      ApiStages: [Match.objectLike({ Stage: Match.anyValue() })],
    });
    template.resourceCountIs("AWS::ApiGateway::UsagePlanKey", 1);
  });

  it("throttles the stage as a backstop", () => {
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: SETTINGS.stageName,
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: "*",
          ResourcePath: "/*",
          ThrottlingRateLimit: SETTINGS.apiRateLimitPerSecond,
          ThrottlingBurstLimit: SETTINGS.apiBurstLimit,
        }),
      ]),
    });
  });

  it("does not create the account-wide API Gateway logging role", () => {
    template.resourceCountIs("AWS::ApiGateway::Account", 0);
  });
});

describe("table", () => {
  it("is on demand, has a TTL and is deleted with the stack", () => {
    const [table] = resources("AWS::DynamoDB::Table");
    expect(table?.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table?.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
    expect(table?.DeletionPolicy).toBe("Delete");
  });

  it("has the same keys and indexes as the table the integration tests create", () => {
    const [table] = resources("AWS::DynamoDB::Table");
    const local = createTableInput("local");
    const deployed = (table?.Properties.GlobalSecondaryIndexes as Record<string, unknown>[]).map((gsi) => ({
      IndexName: gsi.IndexName,
      KeySchema: gsi.KeySchema,
      Projection: gsi.Projection,
    }));
    expect(deployed).toEqual(local.GlobalSecondaryIndexes);
    expect(table?.Properties.KeySchema).toEqual(local.KeySchema);
  });
});

describe("queue and worker", () => {
  it("moves a message to the dead-letter queue after repeated failures", () => {
    const queues = resources("AWS::SQS::Queue");
    const main = queues.find((q) => q.Properties.RedrivePolicy);
    const dlq = queues.find((q) => !q.Properties.RedrivePolicy);
    expect((main?.Properties.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount).toBe(SETTINGS.maxReceiveCount);
    expect(main?.Properties.VisibilityTimeout).toBe(SETTINGS.queueVisibilitySeconds);
    expect(dlq?.Properties.MessageRetentionPeriod).toBe(SETTINGS.dlqRetentionDays * 24 * 3600);
  });

  it("keeps the visibility timeout at six times the worker timeout or more", () => {
    expect(SETTINGS.queueVisibilitySeconds).toBeGreaterThanOrEqual(6 * SETTINGS.workerTimeoutSeconds);
  });

  it("reports failures per message and caps the poller's concurrency", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: SETTINGS.workerBatchSize,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: SETTINGS.workerMaxConcurrency },
    });
  });

  it("keeps the poller's concurrency within the worker's reserved concurrency", () => {
    expect(SETTINGS.workerMaxConcurrency).toBeLessThanOrEqual(SETTINGS.workerReservedConcurrency);
  });
});

describe("functions", () => {
  it("run Node.js 22 on arm64 with reserved concurrency", () => {
    const expected: Record<string, number> = {
      "create-order": SETTINGS.apiReservedConcurrency,
      "get-order": SETTINGS.apiReservedConcurrency,
      "list-orders": SETTINGS.apiReservedConcurrency,
      "allocate-cars": SETTINGS.workerReservedConcurrency,
    };
    for (const [name, reserved] of Object.entries(expected)) {
      const fn = functionByEntry(name);
      expect(fn.Properties.Runtime).toBe("nodejs22.x");
      expect(fn.Properties.Architectures).toEqual(["arm64"]);
      expect(fn.Properties.ReservedConcurrentExecutions).toBe(reserved);
    }
  });

  it("drop reserved concurrency when the context flag turns it off", () => {
    const off = synth(false);
    for (const fn of Object.values(off.findResources("AWS::Lambda::Function"))) {
      expect((fn as Resource).Properties.ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  it("log to groups that keep a week and are deleted with the stack", () => {
    const groups = resources("AWS::Logs::LogGroup");
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(g.Properties.RetentionInDays).toBe(7);
      expect(g.DeletionPolicy).toBe("Delete");
    }
  });
});

describe("permissions", () => {
  it("give each function only the actions it calls", () => {
    expect(policyActions("create-order").sort()).toEqual(
      ["dynamodb:GetItem", "dynamodb:PutItem", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"].sort(),
    );
    expect(policyActions("get-order")).toEqual(["dynamodb:GetItem"]);
    expect(policyActions("list-orders")).toEqual(["dynamodb:Query"]);
    const worker = policyActions("allocate-cars");
    expect(worker).toEqual(expect.arrayContaining(["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]));
    expect(worker).not.toContain("dynamodb:PutItem");
    expect(worker).not.toContain("dynamodb:DeleteItem");
    expect(worker).not.toContain("sqs:SendMessage");
  });
});

describe("outputs", () => {
  it("never include an account id, a queue URL or an ARN", () => {
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/\b\d{12}\b/);
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(Object.keys(outputs)).not.toContain("QueueUrl");
    for (const output of Object.values(outputs)) {
      expect(JSON.stringify(output.Value)).not.toMatch(/QueueUrl|\.Arn"|"Arn"/);
    }
  });
});
