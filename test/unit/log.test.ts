import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/log";

function capture() {
  const lines: string[] = [];
  const log = createLogger({ fn: "create-order" }, { write: (l) => lines.push(l), now: () => new Date("2026-10-21T15:00:00Z") });
  return { lines, log, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("logger", () => {
  it("writes one JSON object per line with level, message, time and base fields", () => {
    const { log, lines, parsed } = capture();
    log.info("order.created", { orderId: "abc" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(parsed()[0]).toEqual({
      level: "info",
      msg: "order.created",
      time: "2026-10-21T15:00:00.000Z",
      fn: "create-order",
      orderId: "abc",
    });
  });

  it("carries child fields such as the request id", () => {
    const { log, parsed } = capture();
    log.child({ requestId: "req-1" }).warn("order.key_reused");
    expect(parsed()[0]).toMatchObject({ level: "warn", fn: "create-order", requestId: "req-1" });
  });

  it("turns errors into name, message and stack", () => {
    const { log, parsed } = capture();
    log.error("request.failed", { err: new TypeError("boom") });
    const err = parsed()[0]?.err as Record<string, unknown>;
    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("boom");
    expect(typeof err.stack).toBe("string");
  });

  it("writes embedded metric format records", () => {
    const { log, parsed } = capture();
    log.metrics({ OrdersAllocated: 1, AllocationAttempts: 2 });
    const record = parsed()[0] as Record<string, unknown> & { _aws: { CloudWatchMetrics: unknown[] } };
    expect(record.OrdersAllocated).toBe(1);
    expect(record.AllocationAttempts).toBe(2);
    expect(record._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: "RailcarOrders",
        Dimensions: [[]],
        Metrics: [
          { Name: "OrdersAllocated", Unit: "Count" },
          { Name: "AllocationAttempts", Unit: "Count" },
        ],
      },
    ]);
  });
});
