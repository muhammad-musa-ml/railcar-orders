/**
 * Runs the allocation race against DynamoDB Local several times, each on a fresh table,
 * and writes the results to results/local/concurrency.json.
 *
 *   npm run ddb:start
 *   npm run local:race -- --runs 5
 */
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { parseArgs } from "node:util";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createLogger } from "../../src/log";
import { createTableInput } from "../../src/store/table";
import { runAllocationRace } from "../lib/allocation-race";
import { writeResult } from "../lib/results";
import { acrossRuns } from "../lib/stats";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    cars: { type: "string", default: "30" },
    orders: { type: "string", default: "40" },
    "max-quantity": { type: "string", default: "3" },
    deliveries: { type: "string", default: "2" },
  },
});
const options = {
  cars: Number(values.cars),
  orders: Number(values.orders),
  maxQuantity: Number(values["max-quantity"]),
  deliveriesPerOrder: Number(values.deliveries),
};

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const client = new DynamoDBClient({
  endpoint,
  region: "us-east-2",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const quiet = createLogger({}, { write: () => {} });

const runs = [];
for (let i = 0; i < Number(values.runs); i++) {
  const tableName = `race-${randomUUID()}`;
  await client.send(new CreateTableCommand(createTableInput(tableName)));
  try {
    const result = await runAllocationRace(doc, tableName, options, quiet);
    runs.push(result);
    console.log(
      `run ${i + 1}: ${result.concurrentAllocationCalls} concurrent calls, ${result.carsAllocated}/${result.carsSeeded} cars allocated, ` +
        `${result.ordersAllocated} allocated / ${result.ordersUnfilled} unfilled, double-allocated cars ${result.doubleAllocatedCars}, ` +
        `violations ${result.violations.length}`,
    );
  } finally {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  }
}

const path = writeResult("local/concurrency.json", {
  kind: "local-concurrency-check",
  command: "npm run local:race",
  ranAt: new Date().toISOString(),
  environment: { dynamodb: "amazon/dynamodb-local:3.3.1 in Docker", node: process.version, cpu: cpus()[0]?.model ?? "unknown" },
  options,
  summary: {
    runs: runs.length,
    concurrentAllocationCallsPerRun: options.orders * options.deliveriesPerOrder,
    doubleAllocatedCars: runs.reduce((n, r) => n + r.doubleAllocatedCars, 0),
    violations: runs.reduce((n, r) => n + r.violations.length, 0),
    ordersStillPending: runs.reduce((n, r) => n + r.ordersStillPending, 0),
    carsAllocated: acrossRuns(runs.map((r) => r.carsAllocated)),
    failedCallsRetriedLater: acrossRuns(runs.map((r) => r.failedCalls)),
    // One attempt = one index read plus one transaction. More attempts than calls means
    // workers collided on cars and retried.
    totalAttempts: acrossRuns(runs.map((r) => r.totalAttempts)),
    maxAttemptsForOneCall: acrossRuns(runs.map((r) => r.maxAttemptsForOneCall)),
    durationMs: acrossRuns(runs.map((r) => r.durationMs)),
  },
  runs,
});
console.log(`wrote ${path}`);
client.destroy();
