import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Car } from "../domain/car";
import type { CarType } from "../domain/order";
import { cancellationCodes } from "./orders";
import { AVAILABLE_CARS_INDEX, availablePk, carPk, orderPk, PARTITION_KEY } from "./table";

export type AllocateResult = "allocated" | "order-not-pending" | "car-taken" | "conflict";

const BATCH_WRITE_LIMIT = 25;

export function toCar(item: Record<string, unknown>): Car {
  const car: Car = {
    carId: item.carId as string,
    carType: item.carType as CarType,
    station: item.station as string,
    status: item.status as Car["status"],
  };
  if (item.orderId !== undefined) car.orderId = item.orderId as string;
  if (item.allocatedAt !== undefined) car.allocatedAt = item.allocatedAt as string;
  return car;
}

export class CarStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /** Adds free cars to inventory (seeding). Overwrites cars with the same id. */
  async putAvailable(cars: readonly Car[]): Promise<void> {
    for (let i = 0; i < cars.length; i += BATCH_WRITE_LIMIT) {
      let pending: Record<string, unknown>[] = cars.slice(i, i + BATCH_WRITE_LIMIT).map((car) => ({
        PutRequest: {
          Item: {
            [PARTITION_KEY]: carPk(car.carId),
            kind: "CAR",
            carId: car.carId,
            carType: car.carType,
            station: car.station,
            status: "AVAILABLE",
            [AVAILABLE_CARS_INDEX.partitionKey]: availablePk(car.station, car.carType),
            [AVAILABLE_CARS_INDEX.sortKey]: car.carId,
          },
        },
      }));
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt > 8) throw new Error(`could not write ${pending.length} cars after retries`);
        if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending } }));
        pending = (res.UnprocessedItems?.[this.tableName] ?? []) as Record<string, unknown>[];
      }
    }
  }

  /** Car ids from the sparse index. Eventually consistent: may include cars just taken. */
  async findAvailable(station: string, carType: CarType, limit: number): Promise<string[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: AVAILABLE_CARS_INDEX.name,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": AVAILABLE_CARS_INDEX.partitionKey },
        ExpressionAttributeValues: { ":pk": availablePk(station, carType) },
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map((item) => item[AVAILABLE_CARS_INDEX.sortKey] as string);
  }

  /**
   * One transaction: every car goes AVAILABLE -> ALLOCATED and the order goes
   * PENDING -> ALLOCATED, or nothing changes. The conditions are what stop a car being
   * taken twice; the index read that chose the cars is only a hint.
   */
  async allocate(orderId: string, carIds: readonly string[], now: Date): Promise<AllocateResult> {
    const at = now.toISOString();
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { [PARTITION_KEY]: orderPk(orderId) },
                UpdateExpression: "SET #status = :allocated, carIds = :carIds, updatedAt = :at",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":allocated": "ALLOCATED",
                  ":pending": "PENDING",
                  ":carIds": [...carIds],
                  ":at": at,
                },
              },
            },
            ...carIds.map((carId) => ({
              Update: {
                TableName: this.tableName,
                Key: { [PARTITION_KEY]: carPk(carId) },
                UpdateExpression: "SET #status = :allocated, orderId = :orderId, allocatedAt = :at REMOVE #availPk, #availSk",
                ConditionExpression: "#status = :available",
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#availPk": AVAILABLE_CARS_INDEX.partitionKey,
                  "#availSk": AVAILABLE_CARS_INDEX.sortKey,
                },
                ExpressionAttributeValues: {
                  ":allocated": "ALLOCATED",
                  ":available": "AVAILABLE",
                  ":orderId": orderId,
                  ":at": at,
                },
              },
            })),
          ],
        }),
      );
      return "allocated";
    } catch (err) {
      const codes = cancellationCodes(err);
      if (!codes) throw err;
      if (codes[0] === "ConditionalCheckFailed") return "order-not-pending";
      if (codes.slice(1).includes("ConditionalCheckFailed")) return "car-taken";
      if (codes.includes("TransactionConflict")) return "conflict";
      throw err;
    }
  }

  /** Every car at a station, read with a filtered scan. For tests and checks, not for requests. */
  async listAtStation(station: string): Promise<Car[]> {
    const cars: Car[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "kind = :car AND station = :station",
          ExpressionAttributeValues: { ":car": "CAR", ":station": station },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      cars.push(...(res.Items ?? []).map(toCar));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return cars;
  }
}
