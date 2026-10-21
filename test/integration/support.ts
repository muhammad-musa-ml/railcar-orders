import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { createLogger } from "../../src/log";
import type { AllocationMessage, OrderQueue } from "../../src/queue";
import { createTableInput } from "../../src/store/table";
import { LOCAL_CREDENTIALS, LOCAL_ENDPOINT, LOCAL_REGION } from "./endpoint";

export interface LocalTable {
  client: DynamoDBClient;
  doc: DynamoDBDocumentClient;
  tableName: string;
  drop: () => Promise<void>;
}

/** Creates a fresh table in DynamoDB Local with the deployed table's keys and indexes. */
export async function createLocalTable(): Promise<LocalTable> {
  const client = new DynamoDBClient({ endpoint: LOCAL_ENDPOINT, region: LOCAL_REGION, credentials: LOCAL_CREDENTIALS });
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const tableName = `test-${randomUUID()}`;
  await client.send(new CreateTableCommand(createTableInput(tableName)));
  return {
    client,
    doc,
    tableName,
    drop: async () => {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      client.destroy();
    },
  };
}

export class MemoryQueue implements OrderQueue {
  readonly messages: AllocationMessage[] = [];
  failures = 0;

  async send(message: AllocationMessage): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("simulated SQS outage");
    }
    this.messages.push(message);
  }
}

export const quietLogger = createLogger({}, { write: () => {} });

/** A clock that moves one second forward each time it is read, so createdAt values sort. */
export function steppingClock(start = "2026-10-21T15:00:00.000Z"): () => Date {
  let t = new Date(start).getTime();
  return () => {
    const now = new Date(t);
    t += 1000;
    return now;
  };
}

export function postEvent(body: unknown, idempotencyKey?: string): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    path: "/orders",
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: null,
  } as unknown as APIGatewayProxyEvent;
}

export function getEvent(
  path: string,
  pathParameters: Record<string, string> | null,
  query: Record<string, string> | null = null,
): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    path,
    headers: {},
    body: null,
    isBase64Encoded: false,
    pathParameters,
    queryStringParameters: query,
  } as unknown as APIGatewayProxyEvent;
}
