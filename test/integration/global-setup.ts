import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { LOCAL_CREDENTIALS, LOCAL_ENDPOINT, LOCAL_REGION } from "./endpoint";

/** Fails fast with a clear message when DynamoDB Local is not running. */
export default async function setup(): Promise<void> {
  const client = new DynamoDBClient({ endpoint: LOCAL_ENDPOINT, region: LOCAL_REGION, credentials: LOCAL_CREDENTIALS });
  let problem: string | undefined;
  try {
    await client.send(new ListTablesCommand({ Limit: 1 }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    problem = err instanceof Error ? `${err.name}: ${err.message || code || "no message"}` : String(err);
  } finally {
    client.destroy();
  }
  if (problem) {
    const message = `DynamoDB Local is not reachable at ${LOCAL_ENDPOINT} (${problem}). Start it with "npm run ddb:start".`;
    const error = new Error(message);
    // vitest 5 crashes while source-mapping stack frames from a global setup file, and the
    // message is lost. A stack without frames prints as-is.
    error.stack = `Error: ${message}`;
    throw error;
  }
}
