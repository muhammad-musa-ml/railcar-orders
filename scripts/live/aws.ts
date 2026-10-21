import { APIGatewayClient, GetApiKeyCommand } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

export const STACK_NAME = "RailcarOrders";
export const REGION = process.env.AWS_REGION ?? "us-east-2";

/**
 * Every live script runs against a named profile and refuses to fall back to whatever
 * default credentials happen to be on the machine.
 */
export function requireProfile(): string {
  const profile = process.env.AWS_PROFILE;
  if (!profile) {
    console.error("Set AWS_PROFILE to the profile to use, e.g. AWS_PROFILE=portfolio AWS_REGION=us-east-2");
    process.exit(2);
  }
  return profile;
}

export interface StackOutputs {
  ApiUrl: string;
  ApiKeyId: string;
  TableName: string;
  QueueName: string;
  DlqName: string;
  CreateOrderFunction: string;
  GetOrderFunction: string;
  ListOrdersFunction: string;
  AllocateCarsFunction: string;
  AllocateCarsLogGroup: string;
  DlqAlarmName: string;
}

const REQUIRED: (keyof StackOutputs)[] = [
  "ApiUrl",
  "ApiKeyId",
  "TableName",
  "QueueName",
  "DlqName",
  "CreateOrderFunction",
  "GetOrderFunction",
  "ListOrdersFunction",
  "AllocateCarsFunction",
  "AllocateCarsLogGroup",
  "DlqAlarmName",
];

export async function stackOutputs(): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue) outputs[o.OutputKey] = o.OutputValue;
  }
  const missing = REQUIRED.filter((k) => !outputs[k]);
  if (missing.length > 0) throw new Error(`stack ${STACK_NAME} is missing outputs: ${missing.join(", ")}`);
  return outputs as unknown as StackOutputs;
}

/** The key's value, held in memory only. Never print it. */
export async function apiKeyValue(keyId: string): Promise<string> {
  const apigw = new APIGatewayClient({ region: REGION });
  const res = await apigw.send(new GetApiKeyCommand({ apiKey: keyId, includeValue: true }));
  if (!res.value) throw new Error("API key has no value");
  return res.value;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
