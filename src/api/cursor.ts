import { BY_SHIPPER_INDEX, PARTITION_KEY, shipperPk } from "../store/table";

const CURSOR_KEYS = [PARTITION_KEY, BY_SHIPPER_INDEX.partitionKey, BY_SHIPPER_INDEX.sortKey].sort();

/** Opaque page token: the DynamoDB LastEvaluatedKey as base64url JSON. */
export function encodeCursor(lastKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastKey), "utf8").toString("base64url");
}

/**
 * Returns the start key, or undefined when the cursor is malformed or belongs to a
 * different shipper's listing.
 */
export function decodeCursor(cursor: string, shipperId: string): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const key = parsed as Record<string, unknown>;
  const keys = Object.keys(key).sort();
  if (keys.length !== CURSOR_KEYS.length || keys.some((k, i) => k !== CURSOR_KEYS[i])) return undefined;
  if (Object.values(key).some((v) => typeof v !== "string")) return undefined;
  if (key[BY_SHIPPER_INDEX.partitionKey] !== shipperPk(shipperId)) return undefined;
  return key as Record<string, string>;
}
