import { randomUUID } from "node:crypto";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createOrder, withErrors } from "../api/orders-api";
import { SqsOrderQueue } from "../queue";
import { OrderStore } from "../store/orders";
import { apiEntry, documentClient, requireEnv } from "./runtime";

const orders = new OrderStore(documentClient(), requireEnv("TABLE_NAME"));
const queue = new SqsOrderQueue(new SQSClient({}), requireEnv("QUEUE_URL"));

export const handler = apiEntry(
  withErrors(createOrder({ orders, queue, now: () => new Date(), newId: randomUUID })),
);
