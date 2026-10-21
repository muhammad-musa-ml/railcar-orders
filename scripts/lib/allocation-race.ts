import { randomUUID } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AllocationError, allocateOrder, type AllocationOutcome } from "../../src/allocation/allocate";
import { checkAllocations } from "../../src/domain/allocation";
import { syntheticCars } from "../../src/domain/car";
import type { CarType, Order } from "../../src/domain/order";
import type { Logger } from "../../src/log";
import { CarStore } from "../../src/store/cars";
import { OrderStore } from "../../src/store/orders";

export interface RaceOptions {
  cars: number;
  orders: number;
  /** Order i asks for 1 + (i mod maxQuantity) cars. */
  maxQuantity: number;
  /** Each order is handed to this many concurrent workers, as duplicate SQS deliveries would be. */
  deliveriesPerOrder: number;
  station?: string;
  carType?: CarType;
  /** Rounds of re-running orders whose every delivery failed, as SQS redelivery would. */
  maxRedeliveryRounds?: number;
}

export interface RaceResult {
  station: string;
  carsSeeded: number;
  orders: number;
  carsRequested: number;
  concurrentAllocationCalls: number;
  ordersAllocated: number;
  ordersUnfilled: number;
  ordersStillPending: number;
  carsAllocated: number;
  failedCalls: number;
  redeliveryRounds: number;
  totalAttempts: number;
  maxAttemptsForOneCall: number;
  doubleAllocatedCars: number;
  violations: string[];
  durationMs: number;
}

/**
 * Seeds `cars` free cars at a fresh station, creates `orders` pending orders for them,
 * then starts every allocation at once and checks the result with checkAllocations.
 */
export async function runAllocationRace(
  doc: DynamoDBDocumentClient,
  tableName: string,
  options: RaceOptions,
  log: Logger,
): Promise<RaceResult> {
  const station = options.station ?? `RACE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const carType = options.carType ?? "BOXCAR";
  const orderStore = new OrderStore(doc, tableName);
  const carStore = new CarStore(doc, tableName);
  const deps = { orders: orderStore, cars: carStore, now: () => new Date() };

  const firstNumber = 100000 + Math.floor(Math.random() * 800000);
  await carStore.putAvailable(syntheticCars(station, carType, options.cars, firstNumber));

  const created = new Date().toISOString();
  const orders: Order[] = Array.from({ length: options.orders }, (_, i) => ({
    orderId: randomUUID(),
    shipperId: "SHP-RACE",
    station,
    carType,
    quantity: 1 + (i % options.maxQuantity),
    loadingDate: created.slice(0, 10),
    status: "PENDING",
    carIds: [],
    createdAt: created,
    updatedAt: created,
  }));
  for (const order of orders) {
    const result = await orderStore.create(order, `race-${order.orderId}`, "race", 0);
    if (result !== "created") throw new Error(`could not create order ${order.orderId}: ${result}`);
  }

  const started = Date.now();
  const calls = orders.flatMap((o) => Array.from({ length: options.deliveriesPerOrder }, () => o.orderId));
  const outcomes: AllocationOutcome[] = [];
  let failedCalls = 0;

  const run = async (orderIds: string[]) => {
    const settled = await Promise.allSettled(orderIds.map((id) => allocateOrder(id, deps, log)));
    for (const s of settled) {
      if (s.status === "fulfilled") outcomes.push(s.value);
      else if (s.reason instanceof AllocationError) failedCalls++;
      else throw s.reason;
    }
  };

  await run(calls);
  let rounds = 0;
  const maxRounds = options.maxRedeliveryRounds ?? 10;
  for (; rounds < maxRounds; rounds++) {
    const pending: string[] = [];
    for (const o of orders) {
      const current = await orderStore.get(o.orderId, true);
      if (current?.status === "PENDING") pending.push(o.orderId);
    }
    if (pending.length === 0) break;
    await run(pending);
  }
  const durationMs = Date.now() - started;

  const finalOrders = (await Promise.all(orders.map((o) => orderStore.get(o.orderId, true)))).filter(
    (o): o is Order => o !== undefined,
  );
  const cars = await carStore.listAtStation(station);
  const violations = checkAllocations(finalOrders, cars);

  const holders = new Map<string, number>();
  for (const o of finalOrders) for (const c of o.carIds) holders.set(c, (holders.get(c) ?? 0) + 1);

  return {
    station,
    carsSeeded: options.cars,
    orders: orders.length,
    carsRequested: orders.reduce((n, o) => n + o.quantity, 0),
    concurrentAllocationCalls: calls.length,
    ordersAllocated: finalOrders.filter((o) => o.status === "ALLOCATED").length,
    ordersUnfilled: finalOrders.filter((o) => o.status === "UNFILLED").length,
    ordersStillPending: finalOrders.filter((o) => o.status === "PENDING").length,
    carsAllocated: cars.filter((c) => c.status === "ALLOCATED").length,
    failedCalls,
    redeliveryRounds: rounds,
    totalAttempts: outcomes.reduce((n, o) => n + o.attempts, 0),
    maxAttemptsForOneCall: outcomes.reduce((n, o) => Math.max(n, o.attempts), 0),
    doubleAllocatedCars: [...holders.values()].filter((n) => n > 1).length,
    violations,
    durationMs,
  };
}
