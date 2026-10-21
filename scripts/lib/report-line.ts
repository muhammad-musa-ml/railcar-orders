export interface Report {
  initDurationMs?: number;
  durationMs: number;
  billedDurationMs: number;
  maxMemoryMb: number;
}

const FIELDS = {
  // "Duration" also appears inside "Billed Duration" and "Init Duration".
  durationMs: /(?<!Billed |Init )Duration: ([0-9.]+) ms/,
  billedDurationMs: /Billed Duration: ([0-9.]+) ms/,
  maxMemoryMb: /Max Memory Used: ([0-9.]+) MB/,
  initDurationMs: /Init Duration: ([0-9.]+) ms/,
};

/**
 * Parses the REPORT line Lambda writes after every invocation, e.g.
 * "REPORT RequestId: ... Duration: 12.34 ms Billed Duration: 13 ms Memory Size: 512 MB
 * Max Memory Used: 80 MB Init Duration: 250.12 ms". Init Duration is present only when
 * the invocation started a new execution environment.
 */
export function parseReport(log: string): Report | undefined {
  const line = log.split("\n").find((l) => l.startsWith("REPORT "));
  if (!line) return undefined;
  const num = (re: RegExp) => {
    const m = re.exec(line);
    return m ? Number(m[1]) : undefined;
  };
  const report: Report = {
    durationMs: num(FIELDS.durationMs) ?? Number.NaN,
    billedDurationMs: num(FIELDS.billedDurationMs) ?? Number.NaN,
    maxMemoryMb: num(FIELDS.maxMemoryMb) ?? Number.NaN,
  };
  const init = num(FIELDS.initDurationMs);
  if (init !== undefined) report.initDurationMs = init;
  return report;
}
