import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, error: string, details?: string[]): APIGatewayProxyResult {
  return json(statusCode, details ? { error, details } : { error });
}

/** Header lookup that ignores case; clients and HTTP/2 disagree about it. */
export function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

export type ParsedBody = { ok: true; value: unknown } | { ok: false };

export function parseJsonBody(event: APIGatewayProxyEvent): ParsedBody {
  if (!event.body) return { ok: false };
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}
