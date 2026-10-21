# Deploying, measuring and tearing down

Everything here runs from a laptop with Node.js 22 and an AWS CLI-style named profile. The AWS CLI itself is not needed: the scripts use the AWS SDK and read the profile from `~/.aws/config` and `~/.aws/credentials`.

All commands below assume:

```sh
export AWS_PROFILE=portfolio
export AWS_REGION=us-east-2
npm ci
```

The scripts refuse to run without `AWS_PROFILE`, so they never fall back to whatever default credentials are on the machine. CDK commands go through `scripts/live/cdk.ts`, which passes `--profile` and removes account ids, ARNs and queue URLs from the CLI output (`cdk deploy` prints the stack ARN, which contains the account id).

## Before the first deploy

1. Set an AWS Budgets alert on the account. Usage plan limits are best effort (see RFC 0001, "Cost guards"), so the budget is the backstop that tells a person.
2. Check the Lambda concurrency quota:

   ```sh
   npm run live:preflight
   ```

   It writes `results/live/preflight-<time>.json` and prints the deploy command to use. New accounts can have a quota too small to reserve any concurrency; the script then says to deploy with `-c reservedConcurrency=false`.
3. Bootstrap CDK once per account and region:

   ```sh
   npm run bootstrap
   ```

## Deploy

```sh
npm run deploy
# or, if the preflight said so:
npm run deploy -- -c reservedConcurrency=false
# optional alarm emails (SNS sends a confirmation email first):
npm run deploy -- -c alarmEmail=<address>
```

The stack is named `RailcarOrders`. Its outputs are names and ids only (API URL, API key id, table, queues, functions, the worker's log group, the DLQ alarm); the API key's value is read at run time by the scripts that need it and is never printed.

## Measure

Each measurement is run five times. `live:summary` then computes the median and range across runs.

```sh
npm run live:load     # POST /orders at 5, 10 and 20 requests/s, then GET at 20/s, 30 s each
npm run live:cold     # 5 forced cold starts per function, Init Duration from REPORT lines
npm run live:race     # 40 orders for 30 cars through the API, each message delivered twice
npm run live:poison   # one unparseable message: time to the DLQ and to the alarm
npm run live:summary  # results/live/summary.json
```

Every script writes its raw run to `results/live/<kind>/run-<time>.json`. The writer refuses to save a file that contains an account id, an ARN or a queue URL.

How each one measures:

- **Load** (`scripts/live/load-test.ts`): open loop. Request *i* is sent at start + *i* / rate whether or not earlier requests have answered, so a slow response cannot slow the sender down and hide itself. Latency is timed at the client until the whole response body arrives, so it includes the network path from the machine running the script to us-east-2. Percentiles are nearest-rank over the 2xx responses of one step; non-2xx responses are counted by status. A short warm-up before each run is not recorded.
- **Cold start** (`scripts/live/cold-start.ts`): changing an environment variable makes Lambda drop its warm execution environments. The script does that, waits for the update to finish, invokes the function once with `LogType=Tail`, and reads `Init Duration` from the `REPORT` line in the returned log tail.
- **Race** (`scripts/live/concurrency-check.ts`): seeds a new station with 30 cars, creates 40 orders for 1 to 3 cars each through the API, sends every order's message a second time straight to the queue, waits until no order is `PENDING`, then runs the same consistency check the integration tests use. It also counts, from the worker's JSON logs, how many orders needed more than one attempt.
- **Poison message** (`scripts/live/poison-check.ts`): sends a body that is not JSON, polls the DLQ until it arrives and the alarm until it reports `ALARM` (the alarm's own state-change time is used), then removes the message and waits for the alarm to return to `OK` before the next run.

## Tear down

```sh
npm run destroy
npm run live:verify-teardown
```

`destroy` deletes the stack. The table, queues, log groups and alarms have a delete removal policy, so nothing from the stack is retained. `live:verify-teardown` lists anything named after the stack that still exists and exits non-zero if it finds something.

What stays on purpose is the CDK bootstrap stack, `CDKToolkit`, with its S3 bucket of uploaded function bundles and its ECR repository. It costs a little for storage while it exists. To remove it, empty the `cdk-hnb659fds-assets-*` bucket (all object versions), then delete the `CDKToolkit` stack in the CloudFormation console; the bucket is retained by the stack and has to be deleted after that.

## Permissions

There are three sets.

**Bootstrap** creates IAM roles, an S3 bucket, an ECR repository, an SSM parameter and a CloudFormation stack. Run it once with an administrator identity. By default the bootstrap's CloudFormation execution role has `AdministratorAccess`; it can be narrowed with `cdk bootstrap --cloudformation-execution-policies <policy ARN>` to a policy covering DynamoDB, SQS, Lambda, API Gateway, IAM roles for the functions, CloudWatch Logs, CloudWatch alarms and SNS.

**Deploy and destroy** run through the bootstrap roles. The profile only needs `sts:AssumeRole` on the deploy, file-publishing and lookup roles that bootstrap created.

**Measurement and teardown checks** call AWS directly. [`docs/iam/measure-policy.json`](iam/measure-policy.json) has every action the scripts use, scoped to resources named after the stack where the API allows it, together with the `sts:AssumeRole` statement for deploying. Replace `<ACCOUNT_ID>` before attaching it.
