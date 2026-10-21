import { describe, expect, it } from "vitest";
import { checkAllocations, pickRandom } from "../../src/domain/allocation";
import type { Car } from "../../src/domain/car";
import type { Order } from "../../src/domain/order";

describe("pickRandom", () => {
  it("returns n distinct items from the input", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    for (let trial = 0; trial < 100; trial++) {
      const picked = pickRandom(items, 7);
      expect(new Set(picked).size).toBe(7);
      expect(picked.every((p) => items.includes(p))).toBe(true);
    }
  });

  it("does not always pick the first items", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const firstPicks = new Set(Array.from({ length: 50 }, () => pickRandom(items, 1)[0]));
    expect(firstPicks.size).toBeGreaterThan(1);
  });

  it("is deterministic for a given random source", () => {
    const items = ["a", "b", "c", "d"];
    expect(pickRandom(items, 2, () => 0)).toEqual(["a", "b"]);
    // i=0 swaps a<->d, i=1 swaps b<->a: [d, a, c, b]
    expect(pickRandom(items, 2, () => 0.99)).toEqual(["d", "a"]);
  });

  it("refuses to pick more than it has", () => {
    expect(() => pickRandom([1, 2], 3)).toThrow(RangeError);
  });
});

const order = (orderId: string, quantity: number, carIds: string[], status: Order["status"] = "ALLOCATED"): Order => ({
  orderId,
  shipperId: "SHP-0042",
  station: "ELMVALE",
  carType: "BOXCAR",
  quantity,
  loadingDate: "2026-11-03",
  status,
  carIds,
  createdAt: "2026-10-21T15:00:00.000Z",
  updatedAt: "2026-10-21T15:00:00.000Z",
});

const car = (carId: string, orderId?: string): Car => ({
  carId,
  carType: "BOXCAR",
  station: "ELMVALE",
  status: orderId ? "ALLOCATED" : "AVAILABLE",
  ...(orderId ? { orderId } : {}),
});

describe("checkAllocations", () => {
  it("passes a consistent allocation", () => {
    const orders = [order("o1", 2, ["c1", "c2"]), order("o2", 1, ["c3"]), order("o3", 4, [], "UNFILLED")];
    const cars = [car("c1", "o1"), car("c2", "o1"), car("c3", "o2"), car("c4")];
    expect(checkAllocations(orders, cars)).toEqual([]);
  });

  it("catches a car listed by two orders", () => {
    const orders = [order("o1", 1, ["c1"]), order("o2", 1, ["c1"])];
    const problems = checkAllocations(orders, [car("c1", "o2")]);
    expect(problems).toContain("car c1 is listed by o1 and o2");
  });

  it("catches an order holding the wrong number of cars", () => {
    const problems = checkAllocations([order("o1", 3, ["c1", "c2"])], [car("c1", "o1"), car("c2", "o1")]);
    expect(problems).toEqual(["order o1 wants 3 cars but holds 2"]);
  });

  it("catches a car that points at an order which does not list it", () => {
    const problems = checkAllocations([order("o1", 1, ["c1"])], [car("c1", "o1"), car("c2", "o1")]);
    expect(problems).toEqual(["car c2 points at o1, which does not list it"]);
  });

  it("catches cars of the wrong type or station", () => {
    const wrong: Car = { ...car("c1", "o1"), station: "OTHER" };
    expect(checkAllocations([order("o1", 1, ["c1"])], [wrong])).toEqual(["car c1 does not match order o1"]);
  });

  it("catches an available car that an order still lists", () => {
    const problems = checkAllocations([order("o1", 1, ["c1"])], [car("c1")]);
    expect(problems).toContain("car c1 is available but tied to an order");
  });
});
