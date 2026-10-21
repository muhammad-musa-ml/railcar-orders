import type { APIGatewayProxyEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/api/cursor";
import { header, parseJsonBody } from "../../src/api/http";
import { parseAllocationMessage } from "../../src/queue";

const event = (partial: Partial<APIGatewayProxyEvent>) => partial as APIGatewayProxyEvent;

describe("cursor", () => {
  const lastKey = { pk: "ORDER#1", gsi1pk: "SHIPPER#SHP-0042", gsi1sk: "2026-10-21T15:00:00.000Z#1" };

  it("round-trips a last evaluated key", () => {
    expect(decodeCursor(encodeCursor(lastKey), "SHP-0042")).toEqual(lastKey);
  });

  it("rejects a cursor from another shipper's listing", () => {
    expect(decodeCursor(encodeCursor(lastKey), "SHP-0099")).toBeUndefined();
  });

  it("rejects garbage and keys with extra or missing fields", () => {
    expect(decodeCursor("not-base64-json", "SHP-0042")).toBeUndefined();
    expect(decodeCursor(encodeCursor({ ...lastKey, extra: "x" }), "SHP-0042")).toBeUndefined();
    expect(decodeCursor(encodeCursor({ pk: "ORDER#1" }), "SHP-0042")).toBeUndefined();
    expect(decodeCursor(encodeCursor({ ...lastKey, gsi1sk: 5 }), "SHP-0042")).toBeUndefined();
  });
});

describe("http helpers", () => {
  it("finds headers whatever their case", () => {
    expect(header(event({ headers: { "Idempotency-Key": "abc" } }), "idempotency-key")).toBe("abc");
    expect(header(event({ headers: { "idempotency-key": "abc" } }), "Idempotency-Key")).toBe("abc");
    expect(header(event({ headers: {} }), "idempotency-key")).toBeUndefined();
  });

  it("parses plain and base64 bodies and refuses bad JSON", () => {
    expect(parseJsonBody(event({ body: '{"a":1}' }))).toEqual({ ok: true, value: { a: 1 } });
    const b64 = Buffer.from('{"a":2}').toString("base64");
    expect(parseJsonBody(event({ body: b64, isBase64Encoded: true }))).toEqual({ ok: true, value: { a: 2 } });
    expect(parseJsonBody(event({ body: "{" }))).toEqual({ ok: false });
    expect(parseJsonBody(event({ body: null }))).toEqual({ ok: false });
  });
});

describe("allocation messages", () => {
  it("accepts an order id and nothing else", () => {
    const orderId = "3f1c2b9e-6a4d-4f0e-9a51-0c7d2e8b1a77";
    expect(parseAllocationMessage(JSON.stringify({ orderId }))).toEqual({ orderId });
    expect(parseAllocationMessage("not json")).toBeUndefined();
    expect(parseAllocationMessage("null")).toBeUndefined();
    expect(parseAllocationMessage(JSON.stringify({ orderId: "ORDER-1" }))).toBeUndefined();
    expect(parseAllocationMessage(JSON.stringify({}))).toBeUndefined();
  });
});
