import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  AVAILABLE_CARS_INDEX,
  BY_SHIPPER_INDEX,
  PARTITION_KEY,
  TTL_ATTRIBUTE,
} from "../src/store/table";

/** Every limit the stack sets, in one place. RFC 0001, "Cost guards" and "Queue and failure handling". */
export const SETTINGS = {
  stageName: "v1",
  apiRateLimitPerSecond: 25,
  apiBurstLimit: 50,
  apiDailyQuota: 20_000,
  apiReservedConcurrency: 5,
  workerReservedConcurrency: 2,
  workerMaxConcurrency: 2,
  workerBatchSize: 5,
  workerTimeoutSeconds: 10,
  apiTimeoutSeconds: 10,
  queueVisibilitySeconds: 60,
  maxReceiveCount: 3,
  dlqRetentionDays: 14,
  memoryMb: 512,
} as const;

export interface RailcarOrdersStackProps extends StackProps {
  /** Off for accounts whose concurrency quota leaves nothing to reserve. */
  reservedConcurrency: boolean;
}

const handlerPath = (name: string) => fileURLToPath(new URL(`../src/handlers/${name}.ts`, import.meta.url));

export class RailcarOrdersStack extends Stack {
  constructor(scope: Construct, id: string, props: RailcarOrdersStackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: BY_SHIPPER_INDEX.name,
      partitionKey: { name: BY_SHIPPER_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: BY_SHIPPER_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    table.addGlobalSecondaryIndex({
      indexName: AVAILABLE_CARS_INDEX.name,
      partitionKey: { name: AVAILABLE_CARS_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: AVAILABLE_CARS_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    const dlq = new sqs.Queue(this, "AllocationDlq", {
      retentionPeriod: Duration.days(SETTINGS.dlqRetentionDays),
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, "AllocationQueue", {
      visibilityTimeout: Duration.seconds(SETTINGS.queueVisibilitySeconds),
      deadLetterQueue: { queue: dlq, maxReceiveCount: SETTINGS.maxReceiveCount },
      enforceSSL: true,
    });

    const fn = (name: string, timeoutSeconds: number, reserved: number, environment: Record<string, string>) => {
      const logGroup = new logs.LogGroup(this, `${name}-logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, name, {
        entry: handlerPath(name),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: SETTINGS.memoryMb,
        timeout: Duration.seconds(timeoutSeconds),
        reservedConcurrentExecutions: props.reservedConcurrency ? reserved : undefined,
        logGroup,
        environment: { TABLE_NAME: table.tableName, ...environment },
        bundling: { minify: true, target: "node22" },
      });
    };

    const createOrder = fn("create-order", SETTINGS.apiTimeoutSeconds, SETTINGS.apiReservedConcurrency, {
      QUEUE_URL: queue.queueUrl,
    });
    const getOrder = fn("get-order", SETTINGS.apiTimeoutSeconds, SETTINGS.apiReservedConcurrency, {});
    const listOrders = fn("list-orders", SETTINGS.apiTimeoutSeconds, SETTINGS.apiReservedConcurrency, {});
    const allocateCars = fn("allocate-cars", SETTINGS.workerTimeoutSeconds, SETTINGS.workerReservedConcurrency, {});

    // Each function gets only the item actions it calls. A transaction needs the
    // permission for every action inside it (PutItem, UpdateItem), not a separate one.
    table.grant(createOrder, "dynamodb:PutItem", "dynamodb:GetItem");
    queue.grantSendMessages(createOrder);
    table.grant(getOrder, "dynamodb:GetItem");
    table.grant(listOrders, "dynamodb:Query");
    table.grant(allocateCars, "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query");

    allocateCars.addEventSource(
      new SqsEventSource(queue, {
        batchSize: SETTINGS.workerBatchSize,
        reportBatchItemFailures: true,
        maxConcurrency: SETTINGS.workerMaxConcurrency,
      }),
    );

    const api = new apigw.RestApi(this, "Api", {
      restApiName: "railcar-orders",
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: false,
      defaultMethodOptions: { apiKeyRequired: true },
      deployOptions: {
        stageName: SETTINGS.stageName,
        throttlingRateLimit: SETTINGS.apiRateLimitPerSecond,
        throttlingBurstLimit: SETTINGS.apiBurstLimit,
      },
    });
    const orders = api.root.addResource("orders");
    orders.addMethod("POST", new apigw.LambdaIntegration(createOrder));
    orders.addMethod("GET", new apigw.LambdaIntegration(listOrders));
    orders.addResource("{orderId}").addMethod("GET", new apigw.LambdaIntegration(getOrder));

    // API Gateway picks the key value; it never appears in the template or the outputs.
    const apiKey = api.addApiKey("ApiKey");
    const plan = api.addUsagePlan("UsagePlan", {
      throttle: { rateLimit: SETTINGS.apiRateLimitPerSecond, burstLimit: SETTINGS.apiBurstLimit },
      quota: { limit: SETTINGS.apiDailyQuota, period: apigw.Period.DAY },
    });
    plan.addApiKey(apiKey);
    plan.addApiStage({ stage: api.deploymentStage });

    // Names and ids only. Queue URLs and ARNs carry the account id, so they are not outputs.
    const outputs: Record<string, string> = {
      ApiUrl: api.url,
      ApiKeyId: apiKey.keyId,
      TableName: table.tableName,
      QueueName: queue.queueName,
      DlqName: dlq.queueName,
      CreateOrderFunction: createOrder.functionName,
      GetOrderFunction: getOrder.functionName,
      ListOrdersFunction: listOrders.functionName,
      AllocateCarsFunction: allocateCars.functionName,
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }
}
