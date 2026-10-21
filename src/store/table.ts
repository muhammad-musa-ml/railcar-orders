import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";
import type { CarType } from "../domain/order";

/**
 * Key and index names shared by the CDK stack, the stores and the local test setup,
 * so the table the tests create is the table that gets deployed.
 */
export const PARTITION_KEY = "pk";
export const TTL_ATTRIBUTE = "expiresAt";

/** Lists one shipper's orders by creation time. Holds whole orders. */
export const BY_SHIPPER_INDEX = {
  name: "byShipper",
  partitionKey: "gsi1pk",
  sortKey: "gsi1sk",
  projection: "ALL",
} as const;

/** Sparse: a car is in it only while free. Keys only, because the sort key is the car id. */
export const AVAILABLE_CARS_INDEX = {
  name: "availableCars",
  partitionKey: "availPk",
  sortKey: "availSk",
  projection: "KEYS_ONLY",
} as const;

export const orderPk = (orderId: string) => `ORDER#${orderId}`;
export const idempotencyPk = (shipperId: string, key: string) => `IDEMPOTENCY#${shipperId}#${key}`;
export const carPk = (carId: string) => `CAR#${carId}`;
export const shipperPk = (shipperId: string) => `SHIPPER#${shipperId}`;
export const availablePk = (station: string, carType: CarType) => `AVAIL#${station}#${carType}`;

/** CreateTable input with the same keys and indexes as the deployed table. Used against DynamoDB Local. */
export function createTableInput(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: PARTITION_KEY, AttributeType: "S" },
      { AttributeName: BY_SHIPPER_INDEX.partitionKey, AttributeType: "S" },
      { AttributeName: BY_SHIPPER_INDEX.sortKey, AttributeType: "S" },
      { AttributeName: AVAILABLE_CARS_INDEX.partitionKey, AttributeType: "S" },
      { AttributeName: AVAILABLE_CARS_INDEX.sortKey, AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: PARTITION_KEY, KeyType: "HASH" }],
    GlobalSecondaryIndexes: [BY_SHIPPER_INDEX, AVAILABLE_CARS_INDEX].map((index) => ({
      IndexName: index.name,
      KeySchema: [
        { AttributeName: index.partitionKey, KeyType: "HASH" as const },
        { AttributeName: index.sortKey, KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: index.projection },
    })),
  };
}
