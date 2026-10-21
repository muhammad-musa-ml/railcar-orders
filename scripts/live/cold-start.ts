/**
 * Measures cold starts. For each function, repeatedly: change an environment variable
 * (which makes Lambda discard its warm execution environments), wait for the update,
 * invoke once with LogType=Tail, and read "Init Duration" from the REPORT line of the
 * returned log tail.
 *
 *   AWS_PROFILE=portfolio npm run live:cold -- --per-function 5
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import { addDays, utcDate } from "../../src/domain/order";
import { parseReport, type Report } from "../lib/report-line";
import { stamp, writeResult } from "../lib/results";
import { summarize } from "../lib/stats";
import { REGION, requireProfile, stackOutputs } from "./aws";

const { values } = parseArgs({ options: { "per-function": { type: "string", default: "5" } } });
const perFunction = Number(values["per-function"]);

requireProfile();
const outputs = await stackOutputs();
const lambda = new LambdaClient({ region: REGION });

const loadingDate = addDays(utcDate(new Date()), 7);
let lastOrderId: string = randomUUID();

/** A harmless event for each function. create-order makes a real (synthetic) order. */
const events: Record<string, () => unknown> = {
  [outputs.CreateOrderFunction]: () => ({
    httpMethod: "POST",
    path: "/orders",
    headers: { "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ shipperId: "SHP-COLD", station: "COLDSTART", carType: "TANK", quantity: 1, loadingDate }),
    isBase64Encoded: false,
  }),
  [outputs.GetOrderFunction]: () => ({
    httpMethod: "GET",
    path: `/orders/${lastOrderId}`,
    pathParameters: { orderId: lastOrderId },
    headers: {},
  }),
  [outputs.ListOrdersFunction]: () => ({
    httpMethod: "GET",
    path: "/orders",
    queryStringParameters: { shipperId: "SHP-COLD", limit: "5" },
    headers: {},
  }),
  [outputs.AllocateCarsFunction]: () => ({
    Records: [{ messageId: randomUUID(), body: JSON.stringify({ orderId: lastOrderId }), attributes: { ApproximateReceiveCount: "1" } }],
  }),
};

const names: Record<string, string> = {
  [outputs.CreateOrderFunction]: "create-order",
  [outputs.GetOrderFunction]: "get-order",
  [outputs.ListOrdersFunction]: "list-orders",
  [outputs.AllocateCarsFunction]: "allocate-cars",
};

async function forceColdStart(functionName: string, mark: string) {
  const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  const variables = { ...(current.Environment?.Variables ?? {}), COLD_START_MARK: mark };
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: functionName, Environment: { Variables: variables } }));
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: functionName });
}

const results: Record<string, { samples: (Report & { statusCode?: number })[]; notCold: number }> = {};
const startedAt = new Date().toISOString();

for (const fn of Object.keys(names)) {
  const name = names[fn] as string;
  results[name] = { samples: [], notCold: 0 };
  for (let i = 0; i < perFunction; i++) {
    await forceColdStart(fn, `${Date.now()}-${i}`);
    const res = await lambda.send(
      new InvokeCommand({
        FunctionName: fn,
        LogType: "Tail",
        Payload: Buffer.from(JSON.stringify((events[fn] as () => unknown)())),
      }),
    );
    if (res.FunctionError) throw new Error(`${name} failed: ${Buffer.from(res.Payload ?? []).toString()}`);
    const payload = JSON.parse(Buffer.from(res.Payload ?? []).toString() || "null") as { statusCode?: number; body?: string } | null;
    if (name === "create-order" && payload?.body) lastOrderId = (JSON.parse(payload.body) as { orderId: string }).orderId;

    const report = parseReport(Buffer.from(res.LogResult ?? "", "base64").toString("utf8"));
    if (!report) throw new Error(`${name}: no REPORT line in the log tail`);
    if (report.initDurationMs === undefined) results[name].notCold++;
    results[name].samples.push({ ...report, statusCode: payload?.statusCode });
    console.log(`${name} #${i + 1}: init ${report.initDurationMs ?? "-"} ms, duration ${report.durationMs} ms`);
  }
}

const summary = Object.fromEntries(
  Object.entries(results).map(([name, r]) => {
    const inits = r.samples.flatMap((s) => (s.initDurationMs !== undefined ? [s.initDurationMs] : []));
    return [
      name,
      {
        coldStarts: inits.length,
        invocationsWithoutInit: r.notCold,
        initDurationMs: inits.length > 0 ? summarize(inits) : null,
        firstInvokeDurationMs: summarize(r.samples.map((s) => s.durationMs)),
      },
    ];
  }),
);

const path = writeResult(`live/cold-start/run-${stamp()}.json`, {
  kind: "cold-start",
  region: REGION,
  startedAt,
  finishedAt: new Date().toISOString(),
  method: "env var change forces a new execution environment; Init Duration read from the REPORT line (Invoke LogType=Tail)",
  perFunction,
  summary,
  samples: results,
});
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${path}`);
