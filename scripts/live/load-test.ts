/**
 * Open-loop load test against the deployed API (see scripts/lib/open-loop.ts). Latency
 * is measured at the client, so it includes the network path from this machine to the
 * region.
 *
 *   AWS_PROFILE=portfolio npm run live:load -- --rates 5,10,20 --seconds 30
 *
 * Each run: a short warm-up that is not recorded, then POST /orders at each rate, then
 * GET /orders/{id} at the highest rate over the orders just created.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { addDays, utcDate } from "../../src/domain/order";
import { openLoop, type StepReport, stepReport, timed } from "../lib/open-loop";
import { stamp, writeResult } from "../lib/results";
import { apiKeyValue, REGION, requireProfile, stackOutputs } from "./aws";

const { values } = parseArgs({
  options: {
    rates: { type: "string", default: "5,10,20" },
    seconds: { type: "string", default: "30" },
    "warmup-seconds": { type: "string", default: "5" },
  },
});
const rates = (values.rates as string).split(",").map(Number);
const seconds = Number(values.seconds);
const warmupSeconds = Number(values["warmup-seconds"]);

requireProfile();
const outputs = await stackOutputs();
const key = await apiKeyValue(outputs.ApiKeyId);
const base = outputs.ApiUrl.replace(/\/$/, "");

const loadingDate = addDays(utcDate(new Date()), 7);
const postOrder = () =>
  timed(`${base}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "idempotency-key": randomUUID() },
    // No cars are seeded at this station, so the worker marks these orders UNFILLED.
    body: JSON.stringify({ shipperId: "SHP-LOAD", station: "LOADTEST", carType: "BOXCAR", quantity: 1, loadingDate }),
  });
const getOrder = (orderId: string) => timed(`${base}/orders/${orderId}`, { headers: { "x-api-key": key } });

const startedAt = new Date().toISOString();
await openLoop(2, warmupSeconds, () => postOrder());

const steps: StepReport[] = [];
const created: string[] = [];
for (const rate of rates) {
  const { samples, sendSeconds } = await openLoop(rate, seconds, () => postOrder());
  created.push(...samples.flatMap((s) => (s.orderId ? [s.orderId] : [])));
  steps.push(stepReport("POST /orders", rate, samples, sendSeconds));
  console.log(JSON.stringify(steps.at(-1)));
}
const top = Math.max(...rates);
if (created.length > 0) {
  const { samples, sendSeconds } = await openLoop(top, seconds, (i) => getOrder(created[i % created.length] as string));
  steps.push(stepReport("GET /orders/{orderId}", top, samples, sendSeconds));
  console.log(JSON.stringify(steps.at(-1)));
}

const path = writeResult(`live/load/run-${stamp()}.json`, {
  kind: "load-test",
  region: REGION,
  startedAt,
  finishedAt: new Date().toISOString(),
  method: "open loop on a fixed schedule; client-side latency of 2xx responses; nearest-rank percentiles",
  secondsPerStep: seconds,
  warmupSeconds,
  steps,
});
console.log(`wrote ${path}`);
