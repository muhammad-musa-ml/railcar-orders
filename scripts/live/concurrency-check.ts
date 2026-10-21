/**
 * Live version of the allocation race. Seeds a fresh station with too few cars, creates
 * orders for them through the API, sends every order's message to the queue a second
 * time (a duplicate delivery), waits until no order is PENDING, then checks that no car
 * belongs to two orders.
 *
 *   AWS_PROFILE=portfolio npm run live:race -- --cars 30 --orders 40
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { checkAllocations } from "../../src/domain/allocation";
import { syntheticCars } from "../../src/domain/car";
import { addDays, type Order, utcDate } from "../../src/domain/order";
import { CarStore } from "../../src/store/cars";
import { OrderStore } from "../../src/store/orders";
import { stamp, writeResult } from "../lib/results";
import { apiKeyValue, REGION, requireProfile, sleep, stackOutputs } from "./aws";

const { values } = parseArgs({
  options: {
    cars: { type: "string", default: "30" },
    orders: { type: "string", default: "40" },
    "max-quantity": { type: "string", default: "3" },
    "client-concurrency": { type: "string", default: "5" },
    "timeout-seconds": { type: "string", default: "180" },
  },
});
const carCount = Number(values.cars);
const orderCount = Number(values.orders);
const maxQuantity = Number(values["max-quantity"]);
const clientConcurrency = Number(values["client-concurrency"]);
const timeoutSeconds = Number(values["timeout-seconds"]);

requireProfile();
const outputs = await stackOutputs();
const key = await apiKeyValue(outputs.ApiKeyId);
const base = outputs.ApiUrl.replace(/\/$/, "");
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqs = new SQSClient({ region: REGION });
const orderStore = new OrderStore(doc, outputs.TableName);
const carStore = new CarStore(doc, outputs.TableName);

const station = `RACE-${randomUUID().slice(0, 8).toUpperCase()}`;
const startedAt = new Date().toISOString();
await carStore.putAvailable(syntheticCars(station, "BOXCAR", carCount, 100000 + Math.floor(Math.random() * 800000)));

// Create orders through the API, a few at a time to stay inside the functions' reserved
// concurrency. A throttled or failed request is retried with the same Idempotency-Key.
const loadingDate = addDays(utcDate(new Date()), 7);
const statuses: Record<string, number> = {};
let retries = 0;
async function createOrder(i: number): Promise<string> {
  const idempotencyKey = randomUUID();
  const body = JSON.stringify({ shipperId: "SHP-RACE", station, carType: "BOXCAR", quantity: 1 + (i % maxQuantity), loadingDate });
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "idempotency-key": idempotencyKey },
      body,
    });
    statuses[String(res.status)] = (statuses[String(res.status)] ?? 0) + 1;
    if (res.status === 201 || res.status === 200) return ((await res.json()) as { orderId: string }).orderId;
    await res.text();
    retries++;
    await sleep(200 * attempt);
  }
  throw new Error(`order ${i} was not created after retries`);
}
const orderIds: string[] = new Array(orderCount);
let next = 0;
await Promise.all(
  Array.from({ length: clientConcurrency }, async () => {
    while (next < orderCount) {
      const i = next++;
      orderIds[i] = await createOrder(i);
    }
  }),
);

// Duplicate delivery: send each order's message again, straight to the queue.
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: outputs.QueueName }));
for (let i = 0; i < orderIds.length; i += 10) {
  await sqs.send(
    new SendMessageBatchCommand({
      QueueUrl,
      Entries: orderIds.slice(i, i + 10).map((orderId, j) => ({ Id: String(j), MessageBody: JSON.stringify({ orderId }) })),
    }),
  );
}

// Wait for the worker to settle every order.
const deadline = Date.now() + timeoutSeconds * 1000;
let orders: Order[];
for (;;) {
  orders = (await Promise.all(orderIds.map((id) => orderStore.get(id, true)))).filter((o): o is Order => o !== undefined);
  const pending = orders.filter((o) => o.status === "PENDING").length;
  if (pending === 0 || Date.now() > deadline) break;
  await sleep(2000);
}
const settledSeconds = (Date.now() - new Date(startedAt).getTime()) / 1000;

const cars = await carStore.listAtStation(station);
const violations = checkAllocations(orders, cars);
const holders = new Map<string, number>();
for (const o of orders) for (const c of o.carIds) holders.set(c, (holders.get(c) ?? 0) + 1);

// How often the worker had to retry because another invocation took a car first.
const logs = new CloudWatchLogsClient({ region: REGION });
const ours = new Set(orderIds);
let attemptsLogged = 0;
let allocationsWithRetries = 0;
let alreadyProcessed = 0;
let nextToken: string | undefined;
do {
  const page = await logs.send(
    new FilterLogEventsCommand({
      logGroupName: outputs.AllocateCarsLogGroup,
      startTime: new Date(startedAt).getTime() - 60_000,
      filterPattern: '{ $.msg = "allocation.*" }',
      nextToken,
    }),
  );
  for (const e of page.events ?? []) {
    const rec = JSON.parse(e.message ?? "{}") as { orderId?: string; msg?: string; attempts?: number };
    if (!rec.orderId || !ours.has(rec.orderId)) continue;
    attemptsLogged++;
    if (rec.msg === "allocation.already-processed") alreadyProcessed++;
    if ((rec.attempts ?? 0) > 1) allocationsWithRetries++;
  }
  nextToken = page.nextToken;
} while (nextToken);

const result = {
  kind: "live-concurrency-check",
  region: REGION,
  startedAt,
  station,
  carsSeeded: carCount,
  orders: orderCount,
  carsRequested: orderIds.reduce((n, _, i) => n + 1 + (i % maxQuantity), 0),
  messagesPerOrder: 2,
  apiStatuses: statuses,
  apiRetries: retries,
  secondsUntilSettled: Math.round(settledSeconds),
  ordersAllocated: orders.filter((o) => o.status === "ALLOCATED").length,
  ordersUnfilled: orders.filter((o) => o.status === "UNFILLED").length,
  ordersStillPending: orders.filter((o) => o.status === "PENDING").length,
  carsAllocated: cars.filter((c) => c.status === "ALLOCATED").length,
  doubleAllocatedCars: [...holders.values()].filter((n) => n > 1).length,
  violations,
  workerLog: { outcomeLines: attemptsLogged, duplicateDeliveriesSkipped: alreadyProcessed, ordersNeedingRetries: allocationsWithRetries },
};
const path = writeResult(`live/concurrency/run-${stamp()}.json`, result);
console.log(JSON.stringify(result, null, 2));
console.log(`wrote ${path}`);
if (violations.length > 0 || result.ordersStillPending > 0) process.exit(1);
