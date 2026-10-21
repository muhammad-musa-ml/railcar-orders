import { describe, expect, it } from "vitest";
import { assertShareable, redact, stamp } from "../../scripts/lib/results";

// Built from parts so no account-id-shaped number sits in the source.
const fakeAccount = ["1234", "5678", "9012"].join("");

describe("redact", () => {
  it("removes account ids, ARNs and queue URLs", () => {
    const text = [
      `Stack ARN: arn:aws:cloudformation:us-east-2:${fakeAccount}:stack/RailcarOrders/abc`,
      `queue https://sqs.us-east-2.amazonaws.com/${fakeAccount}/orders`,
      `account ${fakeAccount}`,
    ].join("\n");
    const out = redact(text);
    expect(out).not.toContain(fakeAccount);
    expect(out).toContain("Stack ARN: <arn>");
    expect(out).toContain("queue <queue-url>");
    expect(out).toContain("account <account>");
  });

  it("leaves latencies, epoch milliseconds and API URLs alone", () => {
    const text = "p99 412.5 ms at 1761062400000, https://abc123.execute-api.us-east-2.amazonaws.com/v1/";
    expect(redact(text)).toBe(text);
  });
});

describe("assertShareable", () => {
  it("throws on an account id and passes clean text", () => {
    expect(() => assertShareable(`{"id":"${fakeAccount}"}`, "x")).toThrow(/account id/);
    expect(() => assertShareable('{"p99":412}', "x")).not.toThrow();
  });
});

describe("stamp", () => {
  it("makes a file-name-safe UTC timestamp", () => {
    expect(stamp(new Date("2026-10-21T15:04:05.123Z"))).toBe("2026-10-21T15-04-05Z");
  });
});
