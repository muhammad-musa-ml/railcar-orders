import { describe, expect, it } from "vitest";
import {
  addDays,
  isCalendarDate,
  isValidIdempotencyKey,
  requestHash,
  utcDate,
  type OrderRequest,
  validateOrderRequest,
} from "../../src/domain/order";

const TODAY = "2026-10-21";
const valid: OrderRequest = {
  shipperId: "SHP-0042",
  station: "ELMVALE",
  carType: "COVERED_HOPPER",
  quantity: 4,
  loadingDate: "2026-11-03",
};

describe("validateOrderRequest", () => {
  it("accepts a well-formed order", () => {
    const result = validateOrderRequest(valid, TODAY);
    expect(result).toEqual({ ok: true, value: valid });
  });

  it("rejects non-objects", () => {
    for (const input of [null, "x", 3, [valid]]) {
      expect(validateOrderRequest(input, TODAY).ok).toBe(false);
    }
  });

  it("reports every problem at once", () => {
    const result = validateOrderRequest(
      { shipperId: "", station: "1X", carType: "HOPPER", quantity: 0, loadingDate: "soon" },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(5);
  });

  it("rejects unknown fields so the request hash covers the whole body", () => {
    const result = validateOrderRequest({ ...valid, priority: "high" }, TODAY);
    expect(result).toEqual({ ok: false, errors: ["unknown field: priority"] });
  });

  it.each([0, 21, 2.5, "4", Number.NaN])("rejects quantity %s", (quantity) => {
    expect(validateOrderRequest({ ...valid, quantity }, TODAY).ok).toBe(false);
  });

  it.each([1, 20])("accepts quantity %s at the boundary", (quantity) => {
    expect(validateOrderRequest({ ...valid, quantity }, TODAY).ok).toBe(true);
  });

  it("accepts today and the last allowed day, rejects the day before and after", () => {
    expect(validateOrderRequest({ ...valid, loadingDate: TODAY }, TODAY).ok).toBe(true);
    expect(validateOrderRequest({ ...valid, loadingDate: "2027-01-19" }, TODAY).ok).toBe(true);
    expect(validateOrderRequest({ ...valid, loadingDate: "2026-10-20" }, TODAY).ok).toBe(false);
    expect(validateOrderRequest({ ...valid, loadingDate: "2027-01-20" }, TODAY).ok).toBe(false);
  });

  it("rejects dates that do not exist", () => {
    expect(validateOrderRequest({ ...valid, loadingDate: "2026-11-31" }, TODAY).ok).toBe(false);
    expect(validateOrderRequest({ ...valid, loadingDate: "2026-11-3" }, TODAY).ok).toBe(false);
  });
});

describe("dates", () => {
  it("uses the UTC calendar date, so a US evening is already tomorrow", () => {
    // 23:30 in Chicago on Oct 21 (CDT, UTC-5) is 04:30 UTC on Oct 22.
    expect(utcDate(new Date("2026-10-22T04:30:00Z"))).toBe("2026-10-22");
  });

  it("knows leap years", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-10-21", 90)).toBe("2027-01-19");
  });
});

describe("idempotency keys and request hashes", () => {
  it("accepts UUIDs and rejects short or odd keys", () => {
    expect(isValidIdempotencyKey("3f1c2b9e-6a4d-4f0e-9a51-0c7d2e8b1a77")).toBe(true);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("has space in it")).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });

  it("hashes the same order the same way whatever the key order", () => {
    const reordered = {
      loadingDate: valid.loadingDate,
      quantity: valid.quantity,
      carType: valid.carType,
      station: valid.station,
      shipperId: valid.shipperId,
    };
    expect(requestHash(reordered)).toBe(requestHash(valid));
  });

  it("hashes different orders differently", () => {
    expect(requestHash({ ...valid, quantity: 5 })).not.toBe(requestHash(valid));
  });
});
