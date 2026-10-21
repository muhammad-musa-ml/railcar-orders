import type { CarType } from "./order";

export type CarStatus = "AVAILABLE" | "ALLOCATED";

export interface Car {
  carId: string;
  carType: CarType;
  station: string;
  status: CarStatus;
  orderId?: string;
  allocatedAt?: string;
}

/** Made-up reporting marks, one per car type. None of these cars exist. */
const MARKS: Record<CarType, string> = {
  BOXCAR: "XMBX",
  COVERED_HOPPER: "XMCH",
  GONDOLA: "XMGN",
  TANK: "XMTK",
};

/** Synthetic empty cars numbered from `firstNumber`, e.g. "XMCH 100000". */
export function syntheticCars(station: string, carType: CarType, count: number, firstNumber: number): Car[] {
  return Array.from({ length: count }, (_, i) => ({
    carId: `${MARKS[carType]} ${firstNumber + i}`,
    carType,
    station,
    status: "AVAILABLE" as const,
  }));
}
