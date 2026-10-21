import { acrossRuns, median, summarize, type Summary } from "./stats";

export interface LoadRun {
  steps: { endpoint: string; targetRate: number; requests: number; ok: number; latencyMsOk: Summary | null }[];
}
export interface ColdRun {
  samples: Record<string, { samples: { initDurationMs?: number }[] }>;
}
export interface RaceRun {
  orders: number;
  carsSeeded: number;
  doubleAllocatedCars: number;
  violations: string[];
  ordersStillPending: number;
  secondsUntilSettled: number;
  workerLog: { ordersNeedingRetries?: number; duplicateDeliveriesSkipped?: number; error?: string };
}
export interface PoisonRun {
  secondsToDlq: number;
  secondsToAlarm: number;
  secondsFromDlqToAlarm: number;
  poisonBodyFoundInDlq: boolean;
}

const across = (values: number[]) => (values.length > 0 ? acrossRuns(values) : null);
const inits = (samples: { initDurationMs?: number }[] = []) =>
  samples.flatMap((s) => (s.initDurationMs !== undefined ? [s.initDurationMs] : []));

/** Median and range across runs of every figure the README reports. */
export function summarizeRuns(load: LoadRun[], cold: ColdRun[], race: RaceRun[], poison: PoisonRun[]) {
  const byStep: Record<string, unknown> = {};
  const stepKeys = new Map<string, { endpoint: string; targetRate: number }>();
  for (const run of load) for (const s of run.steps) stepKeys.set(`${s.endpoint} @ ${s.targetRate}/s`, s);
  for (const [key, { endpoint, targetRate }] of stepKeys) {
    const matching = load.flatMap((r) => r.steps.filter((s) => s.endpoint === endpoint && s.targetRate === targetRate));
    const latencies = matching.flatMap((s) => (s.latencyMsOk ? [s.latencyMsOk] : []));
    byStep[key] = {
      runs: matching.length,
      requests: matching.reduce((n, s) => n + s.requests, 0),
      ok: matching.reduce((n, s) => n + s.ok, 0),
      p50: across(latencies.map((l) => l.p50)),
      p95: across(latencies.map((l) => l.p95)),
      p99: across(latencies.map((l) => l.p99)),
    };
  }

  const byFunction: Record<string, unknown> = {};
  const functions = new Set(cold.flatMap((r) => Object.keys(r.samples)));
  for (const fn of functions) {
    const all = cold.flatMap((r) => inits(r.samples[fn]?.samples));
    const perRun = cold.map((r) => inits(r.samples[fn]?.samples)).filter((v) => v.length > 0);
    byFunction[fn] = {
      coldStarts: all.length,
      allColdStarts: all.length > 0 ? summarize(all) : null,
      perRunMedian: across(perRun.map((v) => median(v))),
    };
  }

  const logged = race.filter((r) => typeof r.workerLog.ordersNeedingRetries === "number");
  return {
    load: { runs: load.length, byStep },
    coldStart: { runs: cold.length, byFunction },
    concurrency: race.length
      ? {
          runs: race.length,
          ordersPerRun: race.map((r) => r.orders),
          carsPerRun: race.map((r) => r.carsSeeded),
          doubleAllocatedCars: race.reduce((n, r) => n + r.doubleAllocatedCars, 0),
          violations: race.reduce((n, r) => n + r.violations.length, 0),
          ordersStillPending: race.reduce((n, r) => n + r.ordersStillPending, 0),
          secondsUntilSettled: across(race.map((r) => r.secondsUntilSettled)),
          runsWithWorkerLogCounts: logged.length,
          ordersNeedingRetries: across(logged.map((r) => r.workerLog.ordersNeedingRetries as number)),
          duplicateDeliveriesSkipped: across(logged.map((r) => r.workerLog.duplicateDeliveriesSkipped as number)),
        }
      : null,
    poison: poison.length
      ? {
          runs: poison.length,
          allFoundInDlq: poison.every((r) => r.poisonBodyFoundInDlq),
          secondsToDlq: across(poison.map((r) => r.secondsToDlq)),
          secondsToAlarm: across(poison.map((r) => r.secondsToAlarm)),
          secondsFromDlqToAlarm: across(poison.map((r) => r.secondsFromDlqToAlarm)),
        }
      : null,
  };
}
