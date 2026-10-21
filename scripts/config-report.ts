/**
 * Synthesizes the stack and records the limits it actually sets (read back from the
 * CloudFormation template, not from the constants) in results/config.json, together
 * with the request limits enforced in code. The README and RFC quote these values.
 *
 *   npm run config:report
 */
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RailcarOrdersStack } from "../lib/railcar-orders-stack";
import { CANDIDATE_LIMIT, MAX_ATTEMPTS } from "../src/allocation/allocate";
import { DEFAULT_PAGE_SIZE, IDEMPOTENCY_TTL_SECONDS, MAX_PAGE_SIZE } from "../src/api/orders-api";
import { CAR_TYPES, MAX_DAYS_AHEAD, MAX_QUANTITY, MIN_QUANTITY } from "../src/domain/order";
import { writeResult } from "./lib/results";

type Res = { Type: string; Properties: Record<string, unknown> };

const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
const stack = new RailcarOrdersStack(app, "RailcarOrders", { reservedConcurrency: true, env: { region: "us-east-2" } });
const resources = Object.entries(Template.fromStack(stack).toJSON().Resources as Record<string, Res>);
const ofType = (type: string) => resources.filter(([, r]) => r.Type === type);
const one = (type: string) => {
  const found = ofType(type);
  if (found.length !== 1) throw new Error(`expected one ${type}, found ${found.length}`);
  return (found[0] as [string, Res])[1].Properties;
};

const plan = one("AWS::ApiGateway::UsagePlan");
const stage = one("AWS::ApiGateway::Stage");
const esm = one("AWS::Lambda::EventSourceMapping");
const queues = ofType("AWS::SQS::Queue").map(([, r]) => r.Properties);
const main = queues.find((q) => q.RedrivePolicy) as Record<string, unknown>;
const dlq = queues.find((q) => !q.RedrivePolicy) as Record<string, unknown>;
const stageSettings = (stage.MethodSettings as Record<string, unknown>[])[0] as Record<string, unknown>;

const functions = Object.fromEntries(
  ofType("AWS::Lambda::Function").map(([id, r]) => [
    id.replace(/[0-9A-F]{8}$/, ""),
    {
      runtime: r.Properties.Runtime,
      architecture: (r.Properties.Architectures as string[])[0],
      memoryMb: r.Properties.MemorySize,
      timeoutSeconds: r.Properties.Timeout,
      reservedConcurrency: r.Properties.ReservedConcurrentExecutions,
    },
  ]),
);

const alarms = ofType("AWS::CloudWatch::Alarm").map(([id, r]) => ({
  alarm: id.replace(/[0-9A-F]{8}$/, ""),
  metric: `${r.Properties.Namespace}/${r.Properties.MetricName}`,
  statistic: r.Properties.ExtendedStatistic ?? r.Properties.Statistic,
  periodSeconds: r.Properties.Period,
  comparison: r.Properties.ComparisonOperator,
  threshold: r.Properties.Threshold,
  treatMissingData: r.Properties.TreatMissingData,
}));

const report = {
  kind: "config-report",
  command: "npm run config:report",
  source: "synthesized CloudFormation template, plus constants in src/",
  api: {
    methodsRequiringApiKey: ofType("AWS::ApiGateway::Method").filter(([, r]) => r.Properties.ApiKeyRequired === true).length,
    methods: ofType("AWS::ApiGateway::Method").length,
    usagePlan: { throttle: plan.Throttle, quota: plan.Quota },
    stageThrottle: { rateLimit: stageSettings.ThrottlingRateLimit, burstLimit: stageSettings.ThrottlingBurstLimit },
  },
  functions,
  queue: {
    visibilityTimeoutSeconds: main.VisibilityTimeout,
    maxReceiveCount: (main.RedrivePolicy as { maxReceiveCount: number }).maxReceiveCount,
    dlqRetentionDays: Number(dlq.MessageRetentionPeriod) / 86400,
  },
  worker: {
    batchSize: esm.BatchSize,
    maximumConcurrency: (esm.ScalingConfig as { MaximumConcurrency: number }).MaximumConcurrency,
    functionResponseTypes: esm.FunctionResponseTypes,
    maxAttemptsPerMessage: MAX_ATTEMPTS,
    candidatesReadPerAttempt: CANDIDATE_LIMIT,
  },
  logs: { retentionDays: [...new Set(ofType("AWS::Logs::LogGroup").map(([, r]) => r.Properties.RetentionInDays))] },
  alarms,
  requests: {
    carTypes: CAR_TYPES,
    quantity: { min: MIN_QUANTITY, max: MAX_QUANTITY },
    loadingDateMaxDaysAhead: MAX_DAYS_AHEAD,
    idempotencyRecordHours: IDEMPOTENCY_TTL_SECONDS / 3600,
    listPageSize: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
  },
};

const path = writeResult("config.json", report);
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${path}`);
