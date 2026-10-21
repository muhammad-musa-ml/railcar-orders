export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
  /** CloudWatch embedded metric format: one log line that CloudWatch also turns into metrics. */
  metrics(values: Record<string, number>, dimensions?: Record<string, string>): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => Date;
  namespace?: string;
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function minLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[configured] ?? LEVELS.info;
}

/**
 * Writes one JSON object per line straight to stdout. Lambda passes raw stdout lines
 * through without its text prefix, so CloudWatch Logs Insights sees the fields as JSON.
 */
export function createLogger(base: Fields = {}, options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const namespace = options.namespace ?? "RailcarOrders";
  const threshold = minLevel();

  const emit = (level: Level, msg: string, fields: Fields = {}) => {
    if (LEVELS[level] < threshold) return;
    const record: Fields = { level, msg, time: now().toISOString(), ...base };
    for (const [k, v] of Object.entries(fields)) record[k] = serialize(v);
    write(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }, { write, now, namespace }),
    metrics: (values, dimensions = {}) => {
      const record: Fields = {
        _aws: {
          Timestamp: now().getTime(),
          CloudWatchMetrics: [
            {
              Namespace: namespace,
              Dimensions: [Object.keys(dimensions)],
              Metrics: Object.keys(values).map((Name) => ({ Name, Unit: "Count" })),
            },
          ],
        },
        ...base,
        ...dimensions,
        ...values,
      };
      write(JSON.stringify(record));
    },
  };
}
