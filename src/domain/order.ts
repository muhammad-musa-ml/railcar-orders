import { createHash } from "node:crypto";

export const CAR_TYPES = ["BOXCAR", "COVERED_HOPPER", "GONDOLA", "TANK"] as const;
export type CarType = (typeof CAR_TYPES)[number];

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 20;
export const MAX_DAYS_AHEAD = 90;

export type OrderStatus = "PENDING" | "ALLOCATED" | "UNFILLED";

export interface OrderRequest {
  shipperId: string;
  station: string;
  carType: CarType;
  quantity: number;
  loadingDate: string;
}

export interface Order extends OrderRequest {
  orderId: string;
  status: OrderStatus;
  carIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SHIPPER_ID = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const STATION = /^[A-Z][A-Z0-9-]{1,23}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const REQUEST_FIELDS = ["shipperId", "station", "carType", "quantity", "loadingDate"] as const;

/** Calendar date (YYYY-MM-DD) of an instant in UTC. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** True when `value` is YYYY-MM-DD and names a day that exists (no 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return utcDate(t);
}

/**
 * Checks a create-order body. `today` is the current UTC calendar date; loading
 * dates are compared against it as strings, which works because both are YYYY-MM-DD.
 */
export function validateOrderRequest(input: unknown, today: string): Validation<OrderRequest> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(body)) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(key)) errors.push(`unknown field: ${key}`);
  }

  const { shipperId, station, carType, quantity, loadingDate } = body;

  if (typeof shipperId !== "string" || !SHIPPER_ID.test(shipperId)) {
    errors.push("shipperId must be 3-32 characters of A-Z, 0-9 and '-'");
  }
  if (typeof station !== "string" || !STATION.test(station)) {
    errors.push("station must be 2-24 characters of A-Z, 0-9 and '-', starting with a letter");
  }
  if (typeof carType !== "string" || !(CAR_TYPES as readonly string[]).includes(carType)) {
    errors.push(`carType must be one of ${CAR_TYPES.join(", ")}`);
  }
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < MIN_QUANTITY ||
    quantity > MAX_QUANTITY
  ) {
    errors.push(`quantity must be a whole number from ${MIN_QUANTITY} to ${MAX_QUANTITY}`);
  }
  if (typeof loadingDate !== "string" || !isCalendarDate(loadingDate)) {
    errors.push("loadingDate must be a calendar date written YYYY-MM-DD");
  } else if (loadingDate < today) {
    errors.push(`loadingDate must not be before ${today} (UTC)`);
  } else if (loadingDate > addDays(today, MAX_DAYS_AHEAD)) {
    errors.push(`loadingDate must be within ${MAX_DAYS_AHEAD} days of ${today} (UTC)`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      shipperId: shipperId as string,
      station: station as string,
      carType: carType as CarType,
      quantity: quantity as number,
      loadingDate: loadingDate as string,
    },
  };
}

export function isValidIdempotencyKey(key: string | undefined): key is string {
  return typeof key === "string" && IDEMPOTENCY_KEY.test(key);
}

/** SHA-256 of the request with its fields in a fixed order, so key order in the body does not matter. */
export function requestHash(req: OrderRequest): string {
  const canonical = JSON.stringify(REQUEST_FIELDS.map((f) => [f, req[f]]));
  return createHash("sha256").update(canonical).digest("hex");
}
