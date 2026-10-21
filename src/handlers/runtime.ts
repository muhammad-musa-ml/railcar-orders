import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { createLogger, type Logger } from "../log";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export function documentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export const baseLogger = createLogger({ fn: process.env.AWS_LAMBDA_FUNCTION_NAME });

type ApiHandler = (event: APIGatewayProxyEvent, log: Logger) => Promise<APIGatewayProxyResult>;

/** Adapts an API handler to Lambda, giving it a logger tagged with the request id. */
export function apiEntry(handler: ApiHandler) {
  return (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> =>
    handler(event, baseLogger.child({ requestId: context.awsRequestId }));
}
