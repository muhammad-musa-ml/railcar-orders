import { pickRandom } from "../domain/allocation";
import type { OrderStatus } from "../domain/order";
import type { Logger } from "../log";
import type { CarStore } from "../store/cars";
import type { OrderStore } from "../store/orders";

export const MAX_ATTEMPTS = 5;
export const CANDIDATE_LIMIT = 100;

export interface AllocatorDeps {
  orders: OrderStore;
  cars: CarStore;
  now: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export type AllocationOutcome =
  | { result: "allocated"; carIds: string[]; attempts: number }
  | { result: "unfilled"; available: number; attempts: number }
  | { result: "already-processed"; status: OrderStatus; attempts: number };

/** Thrown when a message should go back to the queue (and, after enough receives, to the DLQ). */
export class AllocationError extends Error {
  override readonly name = "AllocationError";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Assigns cars to one order. Safe to run for the same order from several workers at
 * once, and safe to repeat: only one transaction can move the order out of PENDING.
 */
export async function allocateOrder(orderId: string, deps: AllocatorDeps, log: Logger): Promise<AllocationOutcome> {
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;

  const order = await deps.orders.get(orderId, true);
  if (!order) throw new AllocationError(`order ${orderId} does not exist`);
  if (order.status !== "PENDING") {
    return { result: "already-processed", status: order.status, attempts: 0 };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidates = await deps.cars.findAvailable(order.station, order.carType, CANDIDATE_LIMIT);
    if (candidates.length < order.quantity) {
      const marked = await deps.orders.markUnfilled(orderId, deps.now());
      if (!marked) {
        const current = await deps.orders.get(orderId, true);
        return { result: "already-processed", status: current?.status ?? "PENDING", attempts: attempt };
      }
      return { result: "unfilled", available: candidates.length, attempts: attempt };
    }

    const picked = pickRandom(candidates, order.quantity, random);
    const result = await deps.cars.allocate(orderId, picked, deps.now());
    if (result === "allocated") return { result: "allocated", carIds: picked, attempts: attempt };
    if (result === "order-not-pending") {
      const current = await deps.orders.get(orderId, true);
      return { result: "already-processed", status: current?.status ?? "PENDING", attempts: attempt };
    }

    // car-taken or conflict: another worker got there first. Look again after a short,
    // random pause so the workers that collided do not retry in lockstep.
    log.debug("allocation.retry", { orderId, attempt, reason: result });
    if (attempt < maxAttempts) await sleep(Math.floor(random() * 25 * attempt));
  }
  throw new AllocationError(`order ${orderId}: no allocation after ${maxAttempts} attempts`);
}
