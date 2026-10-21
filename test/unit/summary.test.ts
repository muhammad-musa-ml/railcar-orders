import { describe, expect, it } from "vitest";
import type { Summary } from "../../scripts/lib/stats";
import { type ColdRun, type LoadRun, type PoisonRun, type RaceRun, summarizeRuns } from "../../scripts/lib/summary";

const latency = (p50: number, p95: number, p99: number): Summary => ({ n: 100, min: 1, p50, p95, p99, max: p99, mean: p50 });

const load: LoadRun[] = [
  { steps: [{ endpoint: "POST /orders", targetRate: 5, requests: 150, ok: 150, latencyMsOk: latency(50, 80, 120) }] },
  { steps: [{ endpoint: "POST /orders", targetRate: 5, requests: 150, ok: 149, latencyMsOk: latency(60, 90, 300) }] },
  { steps: [{ endpoint: "POST /orders", targetRate: 5, requests: 150, ok: 0, latencyMsOk: null }] },
];

const cold: ColdRun[] = [
  { samples: { "get-order": { samples: [{ initDurationMs: 300 }, { initDurationMs: 320 }, {}] } } },
  { samples: { "get-order": { samples: [{ initDurationMs: 280 }, { initDurationMs: 400 }] } } },
];

const race = (n: Partial<RaceRun>): RaceRun => ({
  orders: 40,
  carsSeeded: 30,
  doubleAllocatedCars: 0,
  violations: [],
  ordersStillPending: 0,
  secondsUntilSettled: 10,
  workerLog: { ordersNeedingRetries: 3, duplicateDeliveriesSkipped: 40 },
  ...n,
});

const poison: PoisonRun[] = [
  { secondsToDlq: 190, secondsToAlarm: 300, secondsFromDlqToAlarm: 110, poisonBodyFoundInDlq: true },
  { secondsToDlq: 185, secondsToAlarm: 250, secondsFromDlqToAlarm: 65, poisonBodyFoundInDlq: true },
];

describe("summarizeRuns", () => {
  const s = summarizeRuns(load, cold, [race({}), race({ secondsUntilSettled: 14, workerLog: { error: "denied" } })], poison);

  it("takes the median and range of each load percentile, skipping steps with no successful response", () => {
    expect(s.load.byStep["POST /orders @ 5/s"]).toEqual({
      runs: 3,
      requests: 450,
      ok: 299,
      p50: { runs: 2, median: 55, min: 50, max: 60 },
      p95: { runs: 2, median: 85, min: 80, max: 90 },
      p99: { runs: 2, median: 210, min: 120, max: 300 },
    });
  });

  it("pools cold starts and ignores invocations without an Init Duration", () => {
    expect(s.coldStart.byFunction["get-order"]).toMatchObject({
      coldStarts: 4,
      allColdStarts: { n: 4, min: 280, p50: 300, max: 400 },
      // per-run medians are 310 and 340
      perRunMedian: { runs: 2, median: 325, min: 310, max: 340 },
    });
  });

  it("adds up race failures and leaves out runs whose log read failed", () => {
    expect(s.concurrency).toMatchObject({
      runs: 2,
      doubleAllocatedCars: 0,
      violations: 0,
      secondsUntilSettled: { runs: 2, median: 12, min: 10, max: 14 },
      runsWithWorkerLogCounts: 1,
      ordersNeedingRetries: { runs: 1, median: 3, min: 3, max: 3 },
    });
  });

  it("reports poison timings across runs", () => {
    expect(s.poison).toEqual({
      runs: 2,
      allFoundInDlq: true,
      secondsToDlq: { runs: 2, median: 187.5, min: 185, max: 190 },
      secondsToAlarm: { runs: 2, median: 275, min: 250, max: 300 },
      secondsFromDlqToAlarm: { runs: 2, median: 87.5, min: 65, max: 110 },
    });
  });

  it("is empty with no runs", () => {
    const empty = summarizeRuns([], [], [], []);
    expect(empty).toEqual({ load: { runs: 0, byStep: {} }, coldStart: { runs: 0, byFunction: {} }, concurrency: null, poison: null });
  });
});
