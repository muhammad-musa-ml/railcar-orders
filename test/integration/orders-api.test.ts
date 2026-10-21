import { randomUUID } from "node:crypto";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrder, getOrder, listOrders, withErrors } from "../../src/api/orders-api";
import type { Order, OrderRequest } from "../../src/domain/order";
import { OrderStore } from "../../src/store/orders";
import { orderPk } from "../../src/store/table";
import {
  createLocalTable,
  getEvent,
  type LocalTable,
  MemoryQueue,
  postEvent,
  quietLogger,
  steppingClock,
} from "./support";

const request: OrderRequest = {
  shipperId: "SHP-0042",
  station: "ELMVALE",
  carType: "COVERED_HOPPER",
  quantity: 4,
  loadingDate: "2026-11-03",
};

let table: LocalTable;
let store: OrderStore;
let queue: MemoryQueue;
let create: ReturnType<typeof createOrder>;
let get: ReturnType<typeof getOrder>;
let list: ReturnType<typeof listOrders>;

beforeEach(async () => {
  table = await createLocalTable();
  store = new OrderStore(table.doc, table.tableName);
  queue = new MemoryQueue();
  const deps = { orders: store, queue, now: steppingClock(), newId: randomUUID };
  create = withErrors(createOrder(deps));
  get = withErrors(getOrder(deps));
  list = withErrors(listOrders(deps));
});

afterEach(async () => {
  await table.drop();
});

const body = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

describe("POST /orders", () => {
  it("creates a pending order, queues it, and GET returns it", async () => {
    const res = await create(postEvent(request, "key-00000001"), quietLogger);
    expect(res.statusCode).toBe(201);
    const order = body(res) as unknown as Order;
    expect(order).toMatchObject({ ...request, status: "PENDING", carIds: [] });
    expect(queue.messages).toEqual([{ orderId: order.orderId }]);

    const fetched = await get(getEvent(`/orders/${order.orderId}`, { orderId: order.orderId }), quietLogger);
    expect(fetched.statusCode).toBe(200);
    expect(body(fetched)).toEqual(order);
  });

  it("returns the first order when the same key and body are sent again", async () => {
    const first = body(await create(postEvent(request, "key-00000002"), quietLogger));
    const replay = await create(postEvent(request, "key-00000002"), quietLogger);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers?.["idempotent-replayed"]).toBe("true");
    expect(body(replay)).toEqual(first);
    // Still pending, so the replay queues it again in case the first send was lost.
    expect(queue.messages).toHaveLength(2);
    const page = body(await list(getEvent("/orders", null, { shipperId: request.shipperId }), quietLogger));
    expect(page.orders).toHaveLength(1);
  });

  it("does not queue a replay of an order that is already allocated", async () => {
    const first = body(await create(postEvent(request, "key-00000003"), quietLogger));
    await table.doc.send(
      new UpdateCommand({
        TableName: table.tableName,
        Key: { pk: orderPk(first.orderId as string) },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "ALLOCATED" },
      }),
    );
    const replay = await create(postEvent(request, "key-00000003"), quietLogger);
    expect(replay.statusCode).toBe(200);
    expect(body(replay).status).toBe("ALLOCATED");
    expect(queue.messages).toHaveLength(1);
  });

  it("refuses a reused key with a different body", async () => {
    await create(postEvent(request, "key-00000004"), quietLogger);
    const res = await create(postEvent({ ...request, quantity: 5 }, "key-00000004"), quietLogger);
    expect(res.statusCode).toBe(409);
  });

  it("creates one order when the same request arrives many times at once", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => create(postEvent(request, "key-00000005"), quietLogger)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.every((c) => c === 201 || c === 200 || c === 409)).toBe(true);
    const ids = new Set(results.filter((r) => r.statusCode !== 409).map((r) => body(r).orderId));
    expect(ids.size).toBe(1);
    const page = body(await list(getEvent("/orders", null, { shipperId: request.shipperId }), quietLogger));
    expect(page.orders).toHaveLength(1);
  });

  it("answers 503 when the queue is down, and a retry with the same key queues the order", async () => {
    queue.failures = 1;
    const failed = await create(postEvent(request, "key-00000006"), quietLogger);
    expect(failed.statusCode).toBe(503);
    expect(queue.messages).toHaveLength(0);

    const retry = await create(postEvent(request, "key-00000006"), quietLogger);
    expect(retry.statusCode).toBe(200);
    expect(body(retry).orderId).toBe(body(failed).orderId);
    expect(queue.messages).toEqual([{ orderId: body(failed).orderId }]);
  });

  it("rejects a missing key, bad JSON and invalid fields", async () => {
    expect((await create(postEvent(request), quietLogger)).statusCode).toBe(400);
    expect((await create(postEvent("{not json", "key-00000007"), quietLogger)).statusCode).toBe(400);
    const invalid = await create(postEvent({ ...request, quantity: 0, carType: "CABOOSE" }, "key-00000008"), quietLogger);
    expect(invalid.statusCode).toBe(400);
    expect(body(invalid).details).toHaveLength(2);
    expect(queue.messages).toHaveLength(0);
  });
});

describe("GET /orders/{orderId}", () => {
  it("returns 404 for an unknown order and 400 for a malformed id", async () => {
    const unknown = randomUUID();
    expect((await get(getEvent(`/orders/${unknown}`, { orderId: unknown }), quietLogger)).statusCode).toBe(404);
    expect((await get(getEvent("/orders/abc", { orderId: "abc" }), quietLogger)).statusCode).toBe(400);
  });
});

describe("GET /orders", () => {
  it("pages through one shipper's orders newest first", async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await create(postEvent(request, `key-a-${i}-0000`), quietLogger);
      created.push(body(res).orderId as string);
    }
    for (let i = 0; i < 2; i++) {
      await create(postEvent({ ...request, shipperId: "SHP-0099" }, `key-b-${i}-0000`), quietLogger);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query: Record<string, string> = { shipperId: request.shipperId, limit: "2" };
      if (cursor) query.cursor = cursor;
      const res = await list(getEvent("/orders", null, query), quietLogger);
      expect(res.statusCode).toBe(200);
      const page = body(res) as { orders: Order[]; nextCursor?: string };
      seen.push(...page.orders.map((o) => o.orderId));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toEqual([...created].reverse());
  });

  it("rejects a missing shipper, a bad limit and a cursor from another shipper", async () => {
    for (let i = 0; i < 3; i++) await create(postEvent(request, `key-c-${i}-0000`), quietLogger);
    const first = body(await list(getEvent("/orders", null, { shipperId: request.shipperId, limit: "1" }), quietLogger));
    const cursor = first.nextCursor as string;
    expect(cursor).toBeTypeOf("string");

    expect((await list(getEvent("/orders", null, {}), quietLogger)).statusCode).toBe(400);
    expect((await list(getEvent("/orders", null, { shipperId: "SHP-0042", limit: "0" }), quietLogger)).statusCode).toBe(400);
    expect((await list(getEvent("/orders", null, { shipperId: "SHP-0042", limit: "101" }), quietLogger)).statusCode).toBe(400);
    expect((await list(getEvent("/orders", null, { shipperId: "SHP-0099", cursor }), quietLogger)).statusCode).toBe(400);
  });
});
