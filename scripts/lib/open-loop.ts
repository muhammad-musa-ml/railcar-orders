import { round, summarize, type Summary } from "./stats";

export interface Sample {
  latencyMs: number;
  /** HTTP status, or 0 when the request failed before a response arrived. */
  status: number;
  orderId?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends one request and times it until the whole body has arrived. */
export async function timed(url: string, init: RequestInit): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const latencyMs = performance.now() - started;
    let orderId: string | undefined;
    if (res.ok) {
      try {
        orderId = (JSON.parse(text) as { orderId?: string }).orderId;
      } catch {
        // Not JSON: the sample still counts by its status.
      }
    }
    return { latencyMs, status: res.status, orderId };
  } catch {
    return { latencyMs: performance.now() - started, status: 0 };
  }
}

/**
 * Starts `make(i)` on a fixed schedule, request i at start + i / rate, without waiting
 * for earlier requests to finish, then waits for all of them. A closed loop (send, wait,
 * send) slows down when the server does and under-reports the slow responses.
 */
export async function openLoop(
  rate: number,
  seconds: number,
  make: (i: number) => Promise<Sample>,
): Promise<{ samples: Sample[]; sendSeconds: number }> {
  const total = Math.round(rate * seconds);
  const interval = 1000 / rate;
  const inFlight: Promise<Sample>[] = [];
  const start = performance.now();
  for (let i = 0; i < total; i++) {
    const wait = start + i * interval - performance.now();
    if (wait > 0) await sleep(wait);
    inFlight.push(make(i));
  }
  // Time from the first send to one interval after the last: n requests span n intervals.
  const sendSeconds = (performance.now() - start + interval) / 1000;
  return { samples: await Promise.all(inFlight), sendSeconds };
}

export interface StepReport {
  endpoint: string;
  targetRate: number;
  achievedSendRate: number;
  requests: number;
  ok: number;
  statuses: Record<string, number>;
  latencyMsOk: Summary | null;
}

export function stepReport(endpoint: string, rate: number, samples: Sample[], sendSeconds: number): StepReport {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  return {
    endpoint,
    targetRate: rate,
    achievedSendRate: round(samples.length / sendSeconds, 2),
    requests: samples.length,
    ok: ok.length,
    statuses,
    latencyMsOk: ok.length > 0 ? summarize(ok.map((s) => s.latencyMs)) : null,
  };
}
