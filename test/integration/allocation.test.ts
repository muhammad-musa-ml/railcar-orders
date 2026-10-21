import { randomUUID } from "node:crypto";
import type { SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAllocationRace } from "../../scripts/lib/allocation-race";
import { AllocationError, allocateOrder } from "../../src/allocation/allocate";
import { processBatch } from "../../src/allocation/worker";
import { checkAllocations } from "../../src/domain/allocation";
import { syntheticCars } from "../../src/domain/car";
import type { Order } from "../../src/domain/order";
import { CarStore } from "../../src/store/cars";
import { OrderStore } from "../../src/store/orders";
import { createLocalTable, type LocalTable, quietLogger } from "./support";

let table: LocalTable;
let orders: OrderStore;
let cars: CarStore;
let deps: { orders: OrderStore; cars: CarStore; now: () => Date };

beforeEach(async () => {
  table = await createLocalTable();
  orders = new OrderStore(table.doc, table.tableName);
  cars = new CarStore(table.doc, table.tableName);
  deps = { orders, cars, now: () => new Date("2026-10-21T16:00:00.000Z") };
});

afterEach(async () => {
  await table.drop();
});

async function pendingOrder(quantity: number, station = "ELMVALE"): Promise<Order> {
  const order: Order = {
    orderId: randomUUID(),
    shipperId: "SHP-0042",
    station,
    carType: "BOXCAR",
    quantity,
    loadingDate: "2026-11-03",
    status: "PENDING",
    carIds: [],
    createdAt: "2026-10-21T15:00:00.000Z",
    updatedAt: "2026-10-21T15:00:00.000Z",
  };
  expect(await orders.create(order, `key-${order.orderId}`, "hash", 0)).toBe("created");
  return order;
}

function sqsEvent(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, i) => ({
      messageId: `m-${i}`,
      body,
      attributes: { ApproximateReceiveCount: "1" },
    })),
  } as unknown as SQSEvent;
}

describe("allocateOrder", () => {
  it("assigns exactly the ordered number of cars and takes them out of the index", async () => {
    await cars.putAvailable(syntheticCars("ELMVALE", "BOXCAR", 10, 100000));
    const order = await pendingOrder(4);

    const outcome = await allocateOrder(order.orderId, deps, quietLogger);
    expect(outcome.result).toBe("allocated");

    const stored = await orders.get(order.orderId, true);
    expect(stored?.status).toBe("ALLOCATED");
    expect(stored?.carIds).toHaveLength(4);
    expect(await cars.findAvailable("ELMVALE", "BOXCAR", 100)).toHaveLength(6);
    expect(checkAllocations([stored as Order], await cars.listAtStation("ELMVALE"))).toEqual([]);
  });

  it("marks the order UNFILLED and leaves the cars alone when the station is short", async () => {
    await cars.putAvailable(syntheticCars("ELMVALE", "BOXCAR", 2, 100000));
    const order = await pendingOrder(3);

    const outcome = await allocateOrder(order.orderId, deps, quietLogger);
    expect(outcome).toEqual({ result: "unfilled", available: 2, attempts: 1 });
    expect((await orders.get(order.orderId, true))?.status).toBe("UNFILLED");
    expect(await cars.findAvailable("ELMVALE", "BOXCAR", 100)).toHaveLength(2);
  });

  it("does nothing on a repeated delivery", async () => {
    await cars.putAvailable(syntheticCars("ELMVALE", "BOXCAR", 10, 100000));
    const order = await pendingOrder(4);
    await allocateOrder(order.orderId, deps, quietLogger);

    const again = await allocateOrder(order.orderId, deps, quietLogger);
    expect(again).toEqual({ result: "already-processed", status: "ALLOCATED", attempts: 0 });
    expect(await cars.findAvailable("ELMVALE", "BOXCAR", 100)).toHaveLength(6);
  });

  it("gives one set of cars when eight workers get the same order at once", async () => {
    await cars.putAvailable(syntheticCars("ELMVALE", "BOXCAR", 10, 100000));
    const order = await pendingOrder(4);

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => allocateOrder(order.orderId, deps, quietLogger)));
    expect(outcomes.filter((o) => o.result === "allocated")).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === "already-processed")).toHaveLength(7);
    expect(await cars.findAvailable("ELMVALE", "BOXCAR", 100)).toHaveLength(6);
  });

  it("refuses an order that does not exist", async () => {
    await expect(allocateOrder(randomUUID(), deps, quietLogger)).rejects.toBeInstanceOf(AllocationError);
  });
});

describe("processBatch", () => {
  it("reports only the bad messages as failures", async () => {
    await cars.putAvailable(syntheticCars("ELMVALE", "BOXCAR", 5, 100000));
    const good = await pendingOrder(2);

    const res = await processBatch(
      sqsEvent(JSON.stringify({ orderId: good.orderId }), "not json", JSON.stringify({ orderId: randomUUID() })),
      deps,
      quietLogger,
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-1" }, { itemIdentifier: "m-2" }]);
    expect((await orders.get(good.orderId, true))?.status).toBe("ALLOCATED");
  });
});

describe("concurrent allocation", () => {
  it("never gives a car to two orders when every order races for too few cars", async () => {
    // 40 orders asking for 1-3 cars each (80 in total) against 30 cars, every order
    // handed to two workers at once: 80 concurrent allocation calls.
    const result = await runAllocationRace(
      table.doc,
      table.tableName,
      { cars: 30, orders: 40, maxQuantity: 3, deliveriesPerOrder: 2 },
      quietLogger,
    );

    expect(result.concurrentAllocationCalls).toBe(80);
    expect(result.violations).toEqual([]);
    expect(result.doubleAllocatedCars).toBe(0);
    expect(result.ordersStillPending).toBe(0);
    expect(result.ordersAllocated + result.ordersUnfilled).toBe(40);
    expect(result.carsAllocated).toBeLessThanOrEqual(30);
  });
});
