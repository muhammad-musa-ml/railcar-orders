import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Order } from "../domain/order";
import { BY_SHIPPER_INDEX, idempotencyPk, orderPk, PARTITION_KEY, shipperPk } from "./table";

export interface IdempotencyRecord {
  orderId: string;
  requestHash: string;
}

export type CreateResult = "created" | "key-exists" | "conflict";

export interface OrderPage {
  orders: Order[];
  lastKey?: Record<string, unknown>;
}

const ORDER_FIELDS = [
  "orderId",
  "shipperId",
  "station",
  "carType",
  "quantity",
  "loadingDate",
  "status",
  "carIds",
  "createdAt",
  "updatedAt",
] as const;

export function toOrder(item: Record<string, unknown>): Order {
  const order: Record<string, unknown> = {};
  for (const field of ORDER_FIELDS) order[field] = item[field];
  order.carIds ??= [];
  return order as unknown as Order;
}

export function cancellationCodes(err: unknown): string[] | undefined {
  if (!(err instanceof TransactionCanceledException)) return undefined;
  return (err.CancellationReasons ?? []).map((r) => r.Code ?? "None");
}

export class OrderStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Writes the idempotency record and the order in one transaction. If the record
   * already exists nothing is written and the caller takes the replay path.
   */
  async create(order: Order, idempotencyKey: string, hash: string, expiresAt: number): Promise<CreateResult> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  [PARTITION_KEY]: idempotencyPk(order.shipperId, idempotencyKey),
                  kind: "IDEMPOTENCY",
                  orderId: order.orderId,
                  requestHash: hash,
                  expiresAt,
                },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": PARTITION_KEY },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  [PARTITION_KEY]: orderPk(order.orderId),
                  kind: "ORDER",
                  ...order,
                  [BY_SHIPPER_INDEX.partitionKey]: shipperPk(order.shipperId),
                  [BY_SHIPPER_INDEX.sortKey]: `${order.createdAt}#${order.orderId}`,
                },
                ConditionExpression: "attribute_not_exists(#pk)",
                ExpressionAttributeNames: { "#pk": PARTITION_KEY },
              },
            },
          ],
        }),
      );
      return "created";
    } catch (err) {
      const codes = cancellationCodes(err);
      if (!codes) throw err;
      if (codes[0] === "ConditionalCheckFailed") return "key-exists";
      if (codes.includes("TransactionConflict")) return "conflict";
      throw err;
    }
  }

  async getIdempotencyRecord(shipperId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [PARTITION_KEY]: idempotencyPk(shipperId, key) },
        ConsistentRead: true,
      }),
    );
    if (!res.Item) return undefined;
    return { orderId: res.Item.orderId as string, requestHash: res.Item.requestHash as string };
  }

  async get(orderId: string, consistent = false): Promise<Order | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [PARTITION_KEY]: orderPk(orderId) },
        ConsistentRead: consistent,
      }),
    );
    return res.Item ? toOrder(res.Item) : undefined;
  }

  /** Sets a pending order to UNFILLED. Returns false if it was no longer pending. */
  async markUnfilled(orderId: string, now: Date): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { [PARTITION_KEY]: orderPk(orderId) },
          UpdateExpression: "SET #status = :unfilled, updatedAt = :at",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":unfilled": "UNFILLED", ":pending": "PENDING", ":at": now.toISOString() },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /** Newest first. `startKey` is the `lastKey` of the previous page. */
  async listByShipper(shipperId: string, limit: number, startKey?: Record<string, unknown>): Promise<OrderPage> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: BY_SHIPPER_INDEX.name,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": BY_SHIPPER_INDEX.partitionKey },
        ExpressionAttributeValues: { ":pk": shipperPk(shipperId) },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    return { orders: (res.Items ?? []).map(toOrder), lastKey: res.LastEvaluatedKey };
  }
}
