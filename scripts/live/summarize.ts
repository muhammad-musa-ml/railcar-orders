/**
 * Reads every run under results/live and writes results/live/summary.json: the median
 * and range across runs of each reported figure. The README's tables come from this file.
 *
 *   npm run live:summary
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, writeResult } from "../lib/results";
import { acrossRuns, summarize, type Summary } from "../lib/stats";

const dir = (kind: string) => join(REPO_ROOT, "results", "live", kind);
function runs<T>(kind: string): T[] {
  if (!existsSync(dir(kind))) return [];
  return readdirSync(dir(kind))
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir(kind), f), "utf8")) as T);
}

interface LoadRun {
  steps: { endpoint: string; targetRate: number; requests: number; ok: number; latencyMsOk: Summary | null }[];
}
interface ColdRun {
  samples: Record<string, { samples: { initDurationMs?: number }[] }>;
}
interface RaceRun {
  orders: number;
  carsSeeded: number;
  doubleAllocatedCars: number;
  violations: string[];
  ordersStillPending: number;
  secondsUntilSettled: number;
  workerLog: { ordersNeedingRetries: number; duplicateDeliveriesSkipped: number };
}
interface PoisonRun {
  secondsToDlq: number;
  secondsToAlarm: number;
  secondsFromDlqToAlarm: number;
  poisonBodyFoundInDlq: boolean;
}

const load = runs<LoadRun>("load");
const loadSummary: Record<string, unknown> = {};
for (const step of load[0]?.steps ?? []) {
  const key = `${step.endpoint} @ ${step.targetRate}/s`;
  const matching = load.flatMap((r) => r.steps.filter((s) => s.endpoint === step.endpoint && s.targetRate === step.targetRate));
  const withLatency = matching.filter((s) => s.latencyMsOk);
  loadSummary[key] = {
    requests: matching.reduce((n, s) => n + s.requests, 0),
    ok: matching.reduce((n, s) => n + s.ok, 0),
    p50: acrossRuns(withLatency.map((s) => (s.latencyMsOk as Summary).p50)),
    p95: acrossRuns(withLatency.map((s) => (s.latencyMsOk as Summary).p95)),
    p99: acrossRuns(withLatency.map((s) => (s.latencyMsOk as Summary).p99)),
  };
}

const cold = runs<ColdRun>("cold-start");
const coldSummary: Record<string, unknown> = {};
for (const fn of Object.keys(cold[0]?.samples ?? {})) {
  const inits = cold.flatMap((r) => (r.samples[fn]?.samples ?? []).flatMap((s) => (s.initDurationMs !== undefined ? [s.initDurationMs] : [])));
  const perRunMedians = cold.map((r) => {
    const v = (r.samples[fn]?.samples ?? []).flatMap((s) => (s.initDurationMs !== undefined ? [s.initDurationMs] : []));
    return summarize(v).p50;
  });
  coldSummary[fn] = { allColdStarts: inits.length > 0 ? summarize(inits) : null, perRunMedian: acrossRuns(perRunMedians) };
}

const race = runs<RaceRun>("concurrency");
const poison = runs<PoisonRun>("poison");

const summary = {
  load: { runs: load.length, byStep: loadSummary },
  coldStart: { runs: cold.length, byFunction: coldSummary },
  concurrency: race.length
    ? {
        runs: race.length,
        ordersPerRun: race.map((r) => r.orders),
        carsPerRun: race.map((r) => r.carsSeeded),
        doubleAllocatedCars: race.reduce((n, r) => n + r.doubleAllocatedCars, 0),
        violations: race.reduce((n, r) => n + r.violations.length, 0),
        ordersStillPending: race.reduce((n, r) => n + r.ordersStillPending, 0),
        secondsUntilSettled: acrossRuns(race.map((r) => r.secondsUntilSettled)),
        ordersNeedingRetries: acrossRuns(race.map((r) => r.workerLog.ordersNeedingRetries)),
        duplicateDeliveriesSkipped: acrossRuns(race.map((r) => r.workerLog.duplicateDeliveriesSkipped)),
      }
    : null,
  poison: poison.length
    ? {
        runs: poison.length,
        allFoundInDlq: poison.every((r) => r.poisonBodyFoundInDlq),
        secondsToDlq: acrossRuns(poison.map((r) => r.secondsToDlq)),
        secondsToAlarm: acrossRuns(poison.map((r) => r.secondsToAlarm)),
        secondsFromDlqToAlarm: acrossRuns(poison.map((r) => r.secondsFromDlqToAlarm)),
      }
    : null,
};

const path = writeResult("live/summary.json", summary);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${path}`);
