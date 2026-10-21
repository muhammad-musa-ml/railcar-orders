import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ACCOUNT_ID = /\b\d{12}\b/g;
const ARN = /arn:aws[a-z-]*:[^\s"']+/g;
const QUEUE_URL = /https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[^\s"']+/g;

/** Replaces account ids, ARNs and queue URLs, so CLI output can be shown or saved. */
export function redact(text: string): string {
  return text.replace(ARN, "<arn>").replace(QUEUE_URL, "<queue-url>").replace(ACCOUNT_ID, "<account>");
}

/** Throws if text holds anything `redact` would change. Results are never written in that case. */
export function assertShareable(text: string, what: string): void {
  if (redact(text) !== text) {
    throw new Error(`${what} contains an account id, an ARN or a queue URL; not writing it`);
  }
}

/** File-name-safe UTC timestamp, e.g. 2026-10-21T15-04-05Z. */
export function stamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/** Writes JSON under results/, refusing anything that would leak account details. */
export function writeResult(relativePath: string, data: unknown): string {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  assertShareable(text, relativePath);
  const path = join(REPO_ROOT, "results", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return `results/${relativePath.replace(/\\/g, "/")}`;
}
