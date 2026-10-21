import { describe, expect, it } from "vitest";
import { acrossRuns, median, percentile, summarize } from "../../scripts/lib/stats";

describe("percentile (nearest rank)", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("picks the value at rank ceil(p * n)", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it("returns the maximum for p99 of a small sample", () => {
    expect(percentile([10, 20, 30], 99)).toBe(30);
    expect(percentile([10, 20, 30], 50)).toBe(20);
  });

  it("refuses an empty sample", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
  });
});

describe("median", () => {
  it("handles odd and even counts and unsorted input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("summaries", () => {
  it("summarises latencies", () => {
    const s = summarize([5, 1, 4, 2, 3]);
    expect(s).toEqual({ n: 5, min: 1, p50: 3, p95: 5, p99: 5, max: 5, mean: 3 });
  });

  it("reports median and range across runs", () => {
    expect(acrossRuns([12.34, 10.01, 15.55, 11.2, 13])).toEqual({ runs: 5, median: 12.3, min: 10, max: 15.6 });
  });
});
