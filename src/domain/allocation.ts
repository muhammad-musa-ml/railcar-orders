import type { Car } from "./car";
import type { Order } from "./order";

/**
 * Picks `n` distinct items at random (partial Fisher-Yates). Workers that all take the
 * first `n` index entries would fight over the same cars on every attempt.
 */
export function pickRandom<T>(items: readonly T[], n: number, random: () => number = Math.random): T[] {
  if (n > items.length) throw new RangeError(`cannot pick ${n} of ${items.length}`);
  const pool = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, n);
}

/**
 * Cross-checks orders against cars and returns every broken rule. An empty list means
 * no car is held by two orders, every allocated order holds exactly its quantity of the
 * right cars, and each car and its order point at each other.
 */
export function checkAllocations(orders: readonly Order[], cars: readonly Car[]): string[] {
  const problems: string[] = [];
  const carsById = new Map(cars.map((c) => [c.carId, c]));
  const ordersById = new Map(orders.map((o) => [o.orderId, o]));
  const holder = new Map<string, string>();

  for (const order of orders) {
    if (order.status !== "ALLOCATED") {
      if (order.carIds.length > 0) problems.push(`order ${order.orderId} is ${order.status} but lists cars`);
      continue;
    }
    if (order.carIds.length !== order.quantity) {
      problems.push(`order ${order.orderId} wants ${order.quantity} cars but holds ${order.carIds.length}`);
    }
    if (new Set(order.carIds).size !== order.carIds.length) {
      problems.push(`order ${order.orderId} lists a car twice`);
    }
    for (const carId of order.carIds) {
      const other = holder.get(carId);
      if (other && other !== order.orderId) problems.push(`car ${carId} is listed by ${other} and ${order.orderId}`);
      holder.set(carId, order.orderId);

      const car = carsById.get(carId);
      if (!car) {
        problems.push(`order ${order.orderId} lists unknown car ${carId}`);
        continue;
      }
      if (car.status !== "ALLOCATED" || car.orderId !== order.orderId) {
        problems.push(`car ${carId} is listed by ${order.orderId} but points at ${car.orderId ?? "nothing"}`);
      }
      if (car.carType !== order.carType || car.station !== order.station) {
        problems.push(`car ${carId} does not match order ${order.orderId}`);
      }
    }
  }

  for (const car of cars) {
    if (car.status === "ALLOCATED") {
      const order = car.orderId ? ordersById.get(car.orderId) : undefined;
      if (!order) problems.push(`car ${car.carId} is allocated to unknown order ${car.orderId ?? "(none)"}`);
      else if (!order.carIds.includes(car.carId)) {
        problems.push(`car ${car.carId} points at ${order.orderId}, which does not list it`);
      }
    } else if (car.orderId || holder.has(car.carId)) {
      problems.push(`car ${car.carId} is available but tied to an order`);
    }
  }
  return problems;
}
