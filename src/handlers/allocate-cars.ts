import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { processBatch } from "../allocation/worker";
import { CarStore } from "../store/cars";
import { OrderStore } from "../store/orders";
import { baseLogger, documentClient, requireEnv } from "./runtime";

const doc = documentClient();
const tableName = requireEnv("TABLE_NAME");
const deps = {
  orders: new OrderStore(doc, tableName),
  cars: new CarStore(doc, tableName),
  now: () => new Date(),
};

export const handler = (event: SQSEvent, context: Context): Promise<SQSBatchResponse> =>
  processBatch(event, deps, baseLogger.child({ requestId: context.awsRequestId }));
