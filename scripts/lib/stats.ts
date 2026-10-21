/** Nearest-rank percentile of an ascending array: the smallest value with at least p% of samples at or below it. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError("no samples");
  if (p <= 0) return sorted[0] as number;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

/** Median of an unsorted list; the mean of the two middle values when the count is even. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("no samples");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;

export function summarize(values: readonly number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: round(s[0] as number),
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s[s.length - 1] as number),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

/** Median and range of one figure across runs, the form every reported number takes. */
export function acrossRuns(values: readonly number[]): { runs: number; median: number; min: number; max: number } {
  return {
    runs: values.length,
    median: round(median(values)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}
