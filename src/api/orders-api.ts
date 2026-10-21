import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  isValidIdempotencyKey,
  type Order,
  requestHash,
  utcDate,
  validateOrderRequest,
} from "../domain/order";
import type { Logger } from "../log";
import { isOrderId, type OrderQueue } from "../queue";
import type { OrderStore } from "../store/orders";
import { decodeCursor, encodeCursor } from "./cursor";
import { errorResponse, header, json, parseJsonBody } from "./http";

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface ApiDeps {
  orders: OrderStore;
  queue: OrderQueue;
  now: () => Date;
  newId: () => string;
}

type Handler = (event: APIGatewayProxyEvent, log: Logger) => Promise<APIGatewayProxyResult>;

export function createOrder(deps: ApiDeps): Handler {
  return async (event, log) => {
    const key = header(event, "idempotency-key");
    if (!isValidIdempotencyKey(key)) {
      return errorResponse(400, "Idempotency-Key header is required: 8-128 characters of A-Z, a-z, 0-9, '_' and '-'");
    }
    const body = parseJsonBody(event);
    if (!body.ok) return errorResponse(400, "body must be valid JSON");

    const now = deps.now();
    const validation = validateOrderRequest(body.value, utcDate(now));
    if (!validation.ok) {
      log.info("order.rejected", { errors: validation.errors });
      return errorResponse(400, "invalid order", validation.errors);
    }
    const request = validation.value;
    const hash = requestHash(request);
    const createdAt = now.toISOString();
    const order: Order = {
      orderId: deps.newId(),
      ...request,
      status: "PENDING",
      carIds: [],
      createdAt,
      updatedAt: createdAt,
    };

    const expiresAt = Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS;
    const result = await deps.orders.create(order, key, hash, expiresAt);

    if (result === "created") {
      log.info("order.created", { orderId: order.orderId, shipperId: order.shipperId, quantity: order.quantity });
      return enqueue(deps, log, order, 201, {});
    }

    const record = await deps.orders.getIdempotencyRecord(request.shipperId, key);
    if (!record) {
      // Lost a race with a request using the same key, and the winner has not committed yet.
      log.warn("order.key_in_flight", { shipperId: request.shipperId });
      return errorResponse(409, "a request with this Idempotency-Key is in progress; retry");
    }
    if (record.requestHash !== hash) {
      log.warn("order.key_reused", { shipperId: request.shipperId, orderId: record.orderId });
      return errorResponse(409, "Idempotency-Key was already used with a different request body");
    }
    const existing = await deps.orders.get(record.orderId, true);
    if (!existing) throw new Error(`idempotency record points at missing order ${record.orderId}`);

    log.info("order.replayed", { orderId: existing.orderId, status: existing.status });
    const replayHeaders = { "idempotent-replayed": "true" };
    if (existing.status !== "PENDING") return json(200, existing, replayHeaders);
    // The first attempt may have failed between the write and SendMessage. Allocation is
    // idempotent per order, so sending again is safe.
    return enqueue(deps, log, existing, 200, replayHeaders);
  };
}

async function enqueue(
  deps: ApiDeps,
  log: Logger,
  order: Order,
  status: number,
  headers: Record<string, string>,
): Promise<APIGatewayProxyResult> {
  try {
    await deps.queue.send({ orderId: order.orderId });
  } catch (err) {
    log.error("order.enqueue_failed", { orderId: order.orderId, err });
    return json(503, {
      error: "order saved but not queued for allocation; retry with the same Idempotency-Key",
      orderId: order.orderId,
    });
  }
  return json(status, order, headers);
}

export function getOrder(deps: Pick<ApiDeps, "orders">): Handler {
  return async (event) => {
    const orderId = event.pathParameters?.orderId;
    if (!isOrderId(orderId)) return errorResponse(400, "orderId must be a lowercase UUID");
    const order = await deps.orders.get(orderId);
    return order ? json(200, order) : errorResponse(404, "order not found");
  };
}

export function listOrders(deps: Pick<ApiDeps, "orders">): Handler {
  return async (event) => {
    const params = event.queryStringParameters ?? {};
    const shipperId = params.shipperId;
    if (!shipperId) return errorResponse(400, "shipperId query parameter is required");

    let limit = DEFAULT_PAGE_SIZE;
    if (params.limit !== undefined) {
      limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        return errorResponse(400, `limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
      }
    }

    let startKey: Record<string, string> | undefined;
    if (params.cursor !== undefined) {
      startKey = decodeCursor(params.cursor, shipperId);
      if (!startKey) return errorResponse(400, "cursor is not valid for this shipper");
    }

    const page = await deps.orders.listByShipper(shipperId, limit, startKey);
    return json(200, {
      orders: page.orders,
      ...(page.lastKey ? { nextCursor: encodeCursor(page.lastKey) } : {}),
    });
  };
}

/**
 * Wraps a handler so unexpected errors become a logged 500 with a JSON body. The
 * function itself does not fail, so these show up in the API's 5XXError metric.
 */
export function withErrors(handler: Handler): Handler {
  return async (event, log) => {
    try {
      return await handler(event, log);
    } catch (err) {
      log.error("request.failed", { err, path: event.path, method: event.httpMethod });
      return errorResponse(500, "internal error");
    }
  };
}
