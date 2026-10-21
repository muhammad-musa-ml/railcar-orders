/**
 * Reads every run under results/live and writes results/live/summary.json: the median
 * and range across runs of each reported figure. The README's tables come from this file.
 *
 *   npm run live:summary
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, writeResult } from "../lib/results";
import { type ColdRun, type LoadRun, type PoisonRun, type RaceRun, summarizeRuns } from "../lib/summary";

function runs<T>(kind: string): T[] {
  const dir = join(REPO_ROOT, "results", "live", kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
}

const summary = summarizeRuns(
  runs<LoadRun>("load"),
  runs<ColdRun>("cold-start"),
  runs<RaceRun>("concurrency"),
  runs<PoisonRun>("poison"),
);
if (summary.load.runs + summary.coldStart.runs === 0 && !summary.concurrency && !summary.poison) {
  console.error("no runs under results/live yet; nothing to summarize");
  process.exit(1);
}
const path = writeResult("live/summary.json", summary);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${path}`);
