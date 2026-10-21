/**
 * After `npm run destroy`: confirms the stack and everything it created are gone, and
 * reports what is left on purpose (the CDK bootstrap stack). Prints names and counts
 * only; ARNs and queue URLs carry the account id.
 *
 *   AWS_PROFILE=portfolio npm run live:verify-teardown
 */
import { APIGatewayClient, GetApiKeysCommand, GetRestApisCommand } from "@aws-sdk/client-api-gateway";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListTopicsCommand, SNSClient } from "@aws-sdk/client-sns";
import { ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { stamp, writeResult } from "../lib/results";
import { REGION, requireProfile, STACK_NAME } from "./aws";

requireProfile();
const prefix = `${STACK_NAME}-`;
const API_NAME = "railcar-orders";

async function stackStatus(name: string): Promise<string> {
  try {
    const res = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: name }));
    return res.Stacks?.[0]?.StackStatus ?? "UNKNOWN";
  } catch (err) {
    if (err instanceof Error && /does not exist/.test(err.message)) return "DOES_NOT_EXIST";
    throw err;
  }
}

const lambda = new LambdaClient({ region: REGION });
const functions: string[] = [];
let marker: string | undefined;
do {
  const page = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
  functions.push(...(page.Functions ?? []).map((f) => f.FunctionName ?? ""));
  marker = page.NextMarker;
} while (marker);

const sns = new SNSClient({ region: REGION });
const topicNames: string[] = [];
let topicToken: string | undefined;
do {
  const page = await sns.send(new ListTopicsCommand({ NextToken: topicToken }));
  topicNames.push(...(page.Topics ?? []).map((t) => (t.TopicArn ?? "").split(":").pop() ?? ""));
  topicToken = page.NextToken;
} while (topicToken);

const apigw = new APIGatewayClient({ region: REGION });
const left = {
  stack: await stackStatus(STACK_NAME),
  tables: ((await new DynamoDBClient({ region: REGION }).send(new ListTablesCommand({}))).TableNames ?? []).filter((t) =>
    t.startsWith(prefix),
  ),
  functions: functions.filter((f) => f.startsWith(prefix)),
  logGroups:
    (await new CloudWatchLogsClient({ region: REGION }).send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix })))
      .logGroups?.map((g) => g.logGroupName ?? "") ?? [],
  alarms:
    (await new CloudWatchClient({ region: REGION }).send(new DescribeAlarmsCommand({ AlarmNamePrefix: prefix }))).MetricAlarms?.map(
      (a) => a.AlarmName ?? "",
    ) ?? [],
  queues: ((await new SQSClient({ region: REGION }).send(new ListQueuesCommand({ QueueNamePrefix: prefix }))).QueueUrls ?? []).length,
  topics: topicNames.filter((n) => n.startsWith(prefix)),
  restApis: ((await apigw.send(new GetRestApisCommand({ limit: 500 }))).items ?? []).filter((a) => a.name === API_NAME).length,
  apiKeys: ((await apigw.send(new GetApiKeysCommand({ limit: 500, nameQuery: API_NAME }))).items ?? []).length,
};
const clean =
  left.stack === "DOES_NOT_EXIST" &&
  left.tables.length + left.functions.length + left.logGroups.length + left.alarms.length + left.topics.length === 0 &&
  left.queues + left.restApis + left.apiKeys === 0;

const result = {
  kind: "teardown-check",
  region: REGION,
  checkedAt: new Date().toISOString(),
  clean,
  remainingFromStack: left,
  bootstrapStack: await stackStatus("CDKToolkit"),
};
const path = writeResult(`live/teardown-${stamp()}.json`, result);
console.log(JSON.stringify(result, null, 2));
console.log(`wrote ${path}`);
if (!clean) process.exit(1);
