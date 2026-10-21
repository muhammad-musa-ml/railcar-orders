# RFC 0001: Railcar order intake and allocation

- Status: Accepted
- Author: muhammad-musa-ml
- Date: 2026-10-21
- Review: single author. This document is the record of what was decided, what was rejected and why.

## Context

A shipper who wants to load freight asks the railroad for empty cars: some number of cars of one type, placed at a station, for a loading date. Someone then picks specific cars out of the empties standing at that station and assigns them to the order. If two orders are given the same car, one shipper has no car on loading day, and the crew finds out at the yard.

This project is a small version of that flow, built to learn serverless engineering on AWS: an HTTP API for orders, a queue, and a worker that assigns cars. All data is synthetic. Car numbers, stations and shippers are made up.

Three facts shape the design. Traffic is low and bursty: orders arrive during business hours and nothing happens at night. The stack will be deployed only long enough to measure it and then destroyed. And the public URL must not be a way for a stranger to run up a bill.

## Goals

1. A shipper can create an order (car type, quantity, station, loading date), read it back, and list their orders.
2. Retrying a create request with the same `Idempotency-Key` returns the first order and never creates a second one.
3. A car is never assigned to two orders. This has to hold with several workers running at once and with SQS delivering the same message twice.
4. Failures show up without anyone reading logs. A message that keeps failing ends in a dead-letter queue and trips an alarm; handler errors and slow responses trip alarms too.
5. Idle cost is storage only. Requests without an API key never reach a Lambda function, and every function has a hard cap on how many copies of it can run at once.
6. Everything runs locally for tests (DynamoDB Local in Docker), and the stack deploys and tears down with one command each.

## Non-goals

- Real railroad data, or any link to industry car-hire or car-location systems.
- Partial fills, waitlists, or ranking orders by loading date. An order gets all its cars or none.
- Releasing cars back to inventory after loading, or moving empties between stations.
- Shipper identity. The API key limits cost; it does not identify the caller (see open questions).
- A user interface, more than one region, or more than one environment.

## Proposed design

### Overview

```
shipper --HTTPS, x-api-key--> API Gateway REST API (usage plan)
                                   |
             +---------------------+----------------------+
             v                     v                      v
       create-order            get-order             list-orders
             |                     |                      |
             +-- order + idempotency record --> DynamoDB <+
             |
             | SendMessage {orderId}
             v
       SQS orders queue --(repeated failures)--> dead-letter queue --> alarm
             |
             v
       allocate-cars -- one transaction: cars AVAILABLE -> ALLOCATED,
                        order PENDING -> ALLOCATED --> DynamoDB
```

Four Lambda functions on Node.js 22 (TypeScript, bundled with esbuild), one DynamoDB table, one SQS queue with a dead-letter queue, CloudWatch alarms, all in one AWS CDK stack.

### API

Every route requires the `x-api-key` header. API Gateway answers a request without a valid key with 403 and no Lambda function runs.

| Method and path | Purpose | Responses |
|---|---|---|
| `POST /orders` | create an order; the `Idempotency-Key` header is required | 201 created; 200 replay of an earlier request; 400 invalid input; 409 key reused with a different body; 503 order saved but not queued |
| `GET /orders/{orderId}` | read one order | 200, 400, 404 |
| `GET /orders?shipperId=...&limit=...&cursor=...` | list one shipper's orders, newest first | 200, with `nextCursor` when another page exists; 400 |

Create request body:

```json
{
  "shipperId": "SHP-0042",
  "station": "ELMVALE",
  "carType": "COVERED_HOPPER",
  "quantity": 4,
  "loadingDate": "2026-11-03"
}
```

Validation: the car type comes from a fixed list (boxcar, covered hopper, gondola, tank car); quantity is a whole number from 1 to 20; the loading date is a real calendar date written `YYYY-MM-DD`, no earlier than the current UTC date and at most 90 days ahead. A loading date has no time zone, so it is compared with the UTC calendar date. The catch is that a shipper in a US time zone ordering late in the evening for their own "today" is rejected, because the UTC date has already moved on. I accept that for now and note it under open questions.

### Data model

One DynamoDB table, on-demand capacity, partition key `pk` (string), no sort key. Three kinds of item:

| Item | `pk` | Other attributes |
|---|---|---|
| Order | `ORDER#<orderId>` | shipperId, station, carType, quantity, loadingDate, status (`PENDING`, `ALLOCATED`, `UNFILLED`), carIds, createdAt, updatedAt; `gsi1pk = SHIPPER#<shipperId>`, `gsi1sk = <createdAt>#<orderId>` |
| Idempotency record | `IDEMPOTENCY#<shipperId>#<key>` | orderId, requestHash, `expiresAt` (TTL, 24 hours after creation) |
| Car | `CAR#<carId>` | carType, station, status (`AVAILABLE`, `ALLOCATED`), orderId, allocatedAt; `availPk = AVAIL#<station>#<carType>` and `availSk = <carId>`, present only while the car is free |

Two global secondary indexes:

- `byShipper` on (`gsi1pk`, `gsi1sk`), for the list route.
- `availableCars` on (`availPk`, `availSk`). It is sparse: allocating a car removes `availPk`, so the index only holds free cars. The worker reads candidates from it.

Index reads are eventually consistent, so the index can still list a car that was just taken. The worker only uses the index to pick candidates; the write that takes a car is checked against the base table.

### Creating an order

1. Validate the body and the `Idempotency-Key` header. Compute `requestHash`, a SHA-256 of the validated body with its keys in a fixed order.
2. Write the idempotency record and the order in one `TransactWriteItems` call, each with the condition `attribute_not_exists(pk)`.
3. If the transaction is cancelled because the idempotency record exists, read the record. A different `requestHash` returns 409. The same hash returns the stored order with 200 and the header `Idempotent-Replayed: true`. If that order is still `PENDING`, its message is sent again, because the first attempt may have failed before it reached SQS.
4. After a new order is written, send `{"orderId": ...}` to the orders queue and return 201.
5. If `SendMessage` fails after the write, return 503 and tell the client to retry with the same key. The retry takes the replay path in step 3, which sends the message.

### Allocating cars

The worker takes messages in batches and reports failures per message (`ReportBatchItemFailures`), so one bad message does not send the rest of its batch back to the queue. For each order:

1. Read the order with a consistent read. If it is no longer `PENDING`, a duplicate delivery got there first; acknowledge and stop.
2. Query `availableCars` for the order's station and car type.
3. If fewer cars come back than the order needs, set the order to `UNFILLED` (condition: still `PENDING`) and stop.
4. Pick the needed number of cars at random from the candidates. Every worker reading the index sees the same cars in the same order, so taking the first N would make concurrent workers collide on the same cars every time.
5. In one transaction: for each picked car, set `status = ALLOCATED`, `orderId` and `allocatedAt` and remove `availPk`, under the condition `status = AVAILABLE`; and set the order to `ALLOCATED` with its `carIds`, under the condition `status = PENDING`.
6. If the transaction is cancelled because of the order's condition, another worker finished this order, so acknowledge. If a car's condition failed, or DynamoDB reports a transaction conflict, wait a short random time and go back to step 2. After 5 attempts, report the message as failed so SQS delivers it again later.

The guarantee comes from step 5. A car moves from `AVAILABLE` to `ALLOCATED` in a conditional write, so a second writer's condition fails whatever the index showed and however many workers run. The order's own condition is in the same transaction, which means a duplicate delivery cannot give a second set of cars to an order that already has one.

### Queue and failure handling

- The orders queue has a dead-letter queue with `maxReceiveCount` 3. The visibility timeout is 60 seconds, six times the worker's 10-second timeout.
- A message whose body is not JSON, has no `orderId`, or names an order that does not exist fails on every receive, so SQS moves it to the dead-letter queue after the third. The dead-letter queue keeps messages for 14 days for inspection.
- The worker processes the records of a batch concurrently (batch size 5), so a batch takes about as long as its slowest order.

### Cost guards

The API Gateway documentation is explicit that usage plan throttling and quotas are applied on a best-effort basis and should not be relied on to control cost. So the plan below has one hard cap and several soft ones.

- API keys: every method requires one. Without a key, API Gateway answers 403 and nothing behind it runs.
- Usage plan on the key: 25 requests per second, burst 50, 20,000 requests per day. The stage has the same default throttle. Both are soft limits.
- Reserved concurrency, the hard cap: 5 for each API function and 2 for the worker. The worker's event source mapping also sets maximum concurrency 2. Without that setting, the SQS poller can invoke the worker beyond its reserved concurrency, the throttled invocations count as receives, and good messages drift into the dead-letter queue.
- No provisioned concurrency, no VPC, no NAT gateway. DynamoDB is on demand. Log groups keep 7 days and, like the table and the queues, are deleted with the stack.
- New AWS accounts can start with a total concurrency quota too small to reserve anything, and then the deploy fails. The CDK app reads a `reservedConcurrency` context flag (default on), and a preflight script reads the account's limits and says which setting will deploy. With the flag off, the account's own small quota is the cap.
- An AWS Budgets alert is the account owner's job and is not part of this stack; the README asks for one before the first deploy.

AWS WAF with a rate-based rule would be a hard limit at the front door, but a web ACL bills monthly whether or not it sees traffic, and this stack only lives for a measurement session.

### Observability

- Logs: each function writes one JSON object per line to stdout (level, message, time, Lambda request id, and the order id where there is one), so CloudWatch Logs Insights can filter on fields directly.
- Alarms, all sent to one SNS topic; an email subscription is added only when an `alarmEmail` context value is given at deploy time:
  - dead-letter queue depth: `ApproximateNumberOfMessagesVisible` at least 1 in a one-minute period;
  - orders queue: oldest message older than 300 seconds, which means the worker is stuck or throttled;
  - Lambda `Errors` at least 1 in 5 minutes, one alarm per function;
  - API Gateway `5XXError` at least 1 in 5 minutes;
  - API Gateway `Latency` p99 above 1000 ms over 5 minutes.

  Missing data counts as not breaching, so an idle stack stays green.

### Testing plan

- Unit tests (vitest) for validation, hashing, cursors, the logger and the allocation bookkeeping, with no network.
- CDK assertion tests on the synthesized template: every method requires an API key, the usage plan has a throttle and a quota, the redrive policy, the alarms, runtimes, and the IAM grants of each function.
- Integration tests of the handlers and the worker against DynamoDB Local in Docker, using the same table definition as the stack.
- A concurrency test: more orders than there are cars, all allocated at once, then a check that no car belongs to two orders and every allocated order holds exactly its quantity.
- CI (GitHub Actions) runs lint, typecheck, unit and CDK tests, and `cdk synth`, with no AWS credentials.
- Once deployed: a fixed-rate load test reporting p50/p95/p99, cold starts read from Lambda `REPORT` lines, the concurrency check through the real API, and a poison message to confirm the dead-letter alarm fires. Each runs at least five times and the results are reported as median and range. Then the stack is destroyed.

## Alternatives considered

### Compute: Lambda or Fargate

Fargate tasks behind an Application Load Balancer would have no cold starts and could run long processes. They lost because both the tasks and the load balancer bill by the hour whether orders arrive or not, and this workload is idle most of the day and will be torn down after measurement. Scaling tasks on queue depth also takes minutes, where Lambda scales per message. What Lambda costs here is cold starts on the API path. The plan is to measure them, and provisioned concurrency stays off because it bills while idle.

### Storage: DynamoDB or RDS for PostgreSQL

Postgres would make allocation a short SQL transaction (`SELECT ... FOR UPDATE SKIP LOCKED`, or a unique constraint on car id in an assignment table), and listing orders would be plain SQL. It lost on three counts. An RDS instance bills every hour. Lambda functions opening database connections need RDS Proxy or careful pooling once concurrency grows. And the functions would have to run inside a VPC, where reaching SQS needs a NAT gateway or an interface endpoint, both billed hourly. DynamoDB on demand bills per request and needs no connections, and conditional writes inside transactions give the per-car guarantee directly. The price: access patterns are fixed in advance by the indexes, there are no ad hoc queries, and index reads are eventually consistent.

### Allocation trigger: SQS, inline in the API call, or DynamoDB Streams

Allocating inside `POST /orders` would tie the API's latency and error rate to contention over popular cars, and the shipper would wait through the retries. DynamoDB Streams invoking the worker would remove the separate `SendMessage` call and the 503 case above. But a failing stream record blocks its shard until it expires or goes to an on-failure destination, and there is no queue depth to alarm on. SQS gives redelivery after a visibility timeout, a dead-letter queue, per-message failure reporting, and metrics that map straight onto alarms.

### API type: REST API, HTTP API or function URLs

HTTP APIs cost less and add less latency, but they have no API keys or usage plans. Lambda function URLs offer IAM auth or no auth at all. The REST API is the only one of the three that can require a key and attach a rate limit and a daily quota to it without custom code.

### Access control: API key with usage plan, IAM, or Cognito

AWS says not to use API keys for authentication or authorization, and that applies here: anyone holding the key can create orders for any shipper id. The risk this project guards against is cost, and a key plus reserved concurrency bounds it. IAM (SigV4) would make every caller, the load test included, sign its requests. Cognito would add a user pool and token handling to a system that has no real users. If real shippers ever used it, each would get a Cognito identity and `shipperId` would come from the token.

### Preventing double allocation: conditional writes, one worker, or a lock item

Running exactly one worker would also prevent double allocation, but correctness would then depend on a concurrency setting that anyone could raise later, and nothing in the data would catch the mistake. A lock item per station and car type serializes the contention cleanly but needs a lease and an expiry for holders that crash. Conditional writes put the rule in the data: a car can move to `ALLOCATED` once, however many workers run.

### Idempotency: a separate record, or an order id derived from the key

Deriving the order id from a hash of shipper and key would make the order write idempotent with a single item. It lost because order ids would then be predictable from the key, and a separate record with its own TTL lets old keys expire without touching orders.

## Risks

- Cold starts on the API functions add latency to the first requests after an idle period. They will be measured after deploy. Node.js 22 on arm64 with small bundles keeps them down.
- A busy station and car type means many workers read the same index partition and race for the same cars. Random selection and bounded retries are enough at this scale. Under heavy load the next step is a lock per station and car type, or batching orders per station.
- An order can sit in `PENDING` forever if `SendMessage` fails and the client never retries. The 503 tells the client to retry, but nothing on the server notices if it does not. A transactional outbox (DynamoDB Streams into SQS through EventBridge Pipes) would close this gap.
- Reserved concurrency can fail the deploy on an account with a small concurrency quota (see cost guards).
- SQS stops publishing metrics for a queue that has been idle for hours, and its guide says metrics can lag when the queue becomes active again. The dead-letter queue is idle by design, so its alarm may fire well after the message arrives. The poison-message check measures how long it takes.
- Index reads lag writes, so the worker can pick a car that is already taken. The transaction rejects it and the worker retries; the cost is wasted attempts, and the data stays correct.

## Open questions

- Should an `UNFILLED` order be retried when cars are added, or stay closed until the shipper orders again?
- Should each API key map to one shipper, so that `shipperId` is not taken from the request body?
- Is 24 hours long enough to keep idempotency records? A client that retries a day later creates a second order.
- Should partial fills be allowed when a station is short of cars?
- Should loading dates be checked against the shipper's local date? That needs a time zone per station.

## Decision

Build the design above. Departures found during implementation are recorded under Amendments below, and the sections above stay as they were accepted.

## Amendments

### 2026-10-21: details settled during implementation

1. **A second kind of 409.** When the same request arrives several times at once, a losing transaction can be cancelled before the winning one has committed, so the idempotency record is not there yet when the loser looks for it. That request gets 409 with "in progress; retry", and a retry a moment later takes the replay path in step 3 of "Creating an order".
2. **What the per-function `Errors` alarms see.** The API handlers catch unexpected errors, log them and return a JSON 500, so the invocation itself succeeds and the error shows in the API `5XXError` alarm. The worker reports a failed message to SQS in its batch response, which is also a successful invocation; those failures surface through the dead-letter alarm. The `Errors` alarms therefore fire on crashes, timeouts and running out of memory, which is narrower than the Observability section implies.
3. **Custom metrics.** The worker writes CloudWatch embedded metric format lines with `OrdersAllocated`, `OrdersUnfilled` and `AllocationAttempts` in a `RailcarOrders` namespace. No alarm uses them. `AllocationAttempts` above one for an order means workers collided on cars.
4. **Recovery notices.** Every alarm also notifies the topic when it returns to OK.
