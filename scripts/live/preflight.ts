/**
 * Reads the account's Lambda concurrency quota and says whether the stack's reserved
 * concurrency fits. Lambda keeps a minimum unreserved pool (100 per the Lambda guide,
 * "Configuring reserved concurrency"); new accounts can start with a quota too small to
 * reserve anything, and then the deploy fails.
 *
 *   AWS_PROFILE=portfolio npm run live:preflight
 */
import { GetAccountSettingsCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SETTINGS } from "../../lib/railcar-orders-stack";
import { stamp, writeResult } from "../lib/results";
import { REGION, requireProfile } from "./aws";

const MIN_UNRESERVED = 100;

requireProfile();
const lambda = new LambdaClient({ region: REGION });
const settings = await lambda.send(new GetAccountSettingsCommand({}));
const accountLimit = settings.AccountLimit?.ConcurrentExecutions ?? 0;
const unreserved = settings.AccountLimit?.UnreservedConcurrentExecutions ?? 0;
const wanted = 3 * SETTINGS.apiReservedConcurrency + SETTINGS.workerReservedConcurrency;
const fits = unreserved - wanted >= MIN_UNRESERVED;

const result = {
  measuredAt: new Date().toISOString(),
  region: REGION,
  accountConcurrencyLimit: accountLimit,
  unreservedConcurrency: unreserved,
  reservedConcurrencyWanted: wanted,
  minimumUnreservedPool: MIN_UNRESERVED,
  reservedConcurrencyFits: fits,
  deployWith: fits ? "npm run deploy" : "npm run deploy -- -c reservedConcurrency=false",
};
const path = writeResult(`live/preflight-${stamp()}.json`, result);
console.log(JSON.stringify(result, null, 2));
console.log(`wrote ${path}`);
