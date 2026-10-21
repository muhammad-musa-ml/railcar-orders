import { describe, expect, it } from "vitest";
import { parseReport } from "../../scripts/lib/report-line";

const cold =
  "START RequestId: 0b6c Version: $LATEST\n" +
  '{"level":"info","msg":"order.created"}\n' +
  "END RequestId: 0b6c\n" +
  "REPORT RequestId: 0b6c\tDuration: 41.27 ms\tBilled Duration: 42 ms\tMemory Size: 512 MB\tMax Memory Used: 91 MB\tInit Duration: 287.55 ms\t\n";

describe("parseReport", () => {
  it("reads every field of a cold start", () => {
    expect(parseReport(cold)).toEqual({
      durationMs: 41.27,
      billedDurationMs: 42,
      maxMemoryMb: 91,
      initDurationMs: 287.55,
    });
  });

  it("leaves initDurationMs out on a warm invocation", () => {
    const warm = cold.replace("\tInit Duration: 287.55 ms", "");
    const report = parseReport(warm);
    expect(report?.initDurationMs).toBeUndefined();
    expect(report?.durationMs).toBe(41.27);
  });

  it("does not mistake Billed or Init Duration for Duration when fields are reordered", () => {
    const line = "REPORT RequestId: x Init Duration: 300.1 ms Billed Duration: 9 ms Duration: 8.5 ms Max Memory Used: 70 MB";
    expect(parseReport(line)).toEqual({ durationMs: 8.5, billedDurationMs: 9, maxMemoryMb: 70, initDurationMs: 300.1 });
  });

  it("returns undefined without a REPORT line", () => {
    expect(parseReport("START RequestId: x\nEND RequestId: x\n")).toBeUndefined();
  });
});
