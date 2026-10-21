# railcar-orders

A small serverless system on AWS for one railroad task: a shipper orders empty railcars for a loading date, and a worker assigns specific cars from the empties standing at the shipper's station. It runs on API Gateway, Lambda (Node.js 22, TypeScript), DynamoDB and SQS, and is deployed with the AWS CDK.

All data in this repository is synthetic. Stations, shippers and car numbers are made up, and the reporting marks used for cars (`XMBX`, `XMCH`, `XMGN`, `XMTK`) do not belong to any railroad.

The design, including the options I turned down and why, is in [RFC 0001](docs/rfc/0001-car-order-allocation.md).

## How it works

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

- `POST /orders` checks the order, writes it together with an idempotency record in one DynamoDB transaction, and puts the order id on an SQS queue. Sending the same request again with the same `Idempotency-Key` header returns the first order. Reusing a key with a different body gets a 409.
- `GET /orders/{orderId}` reads one order. `GET /orders?shipperId=...` lists a shipper's orders, newest first, paged with an opaque cursor.
- The `allocate-cars` worker takes messages in batches and assigns cars. It reports failures per message, so a bad message is retried on its own; after three failed receives SQS moves it to the dead-letter queue, and an alarm fires.
- Every route needs an API key. The key is on a usage plan with a rate limit and a daily quota, and each function has reserved concurrency, which is the one hard cap on how much can run at once.
- Every function logs one JSON object per line. CloudWatch alarms watch dead-letter queue depth, the age of the oldest queued message, errors in each function, API 5xx responses and API p99 latency.

### Taking a car exactly once

The worker reads candidate cars from a sparse index that only holds free cars, picks the number it needs at random, and writes everything in one transaction:

- each car goes from `AVAILABLE` to `ALLOCATED`, under the condition `status = AVAILABLE`;
- the order goes from `PENDING` to `ALLOCATED` with its car ids, under the condition `status = PENDING`.

If another worker took one of the cars first, that car's condition fails and nothing in the transaction is written. The worker then reads the index again and retries a few times before handing the message back to the queue. The index is eventually consistent and can still list a car that was just taken; that costs a retry and nothing else, because the check that matters runs against the table itself. The order's own condition means a duplicate SQS delivery cannot give one order two sets of cars. Random picking keeps workers that read the same index page from fighting over the same cars on every attempt.

If the station has fewer free cars than the order asks for, the order is marked `UNFILLED`. There are no partial fills.

## Layout

| Path | Contents |
|---|---|
| `src/domain` | order validation, car records, the allocation consistency check |
| `src/api` | the three HTTP handlers, written against injected stores so tests can call them directly |
| `src/store` | DynamoDB access: table definition, orders, cars and the allocation transaction |
| `src/allocation` | the allocation loop and the SQS batch handler |
| `src/handlers` | Lambda entry points that connect the real AWS clients to the code above |
| `lib`, `bin` | the CDK stack and its alarms |
| `test/unit` | unit tests and CDK template assertions, no network |
| `test/integration` | handlers and worker against DynamoDB Local in Docker, including the concurrency test |
| `scripts` | the local race, the config report, and the deploy, measurement and teardown scripts |
| `results` | output of every run quoted in this README |

## Running the tests

```sh
npm ci
npm run lint
npm run typecheck
npm test                  # unit tests and CDK template assertions
npm run synth             # needs no AWS credentials

npm run ddb:start         # DynamoDB Local in Docker
npm run test:integration
npm run ddb:stop
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, the unit tests and `cdk synth` on pushes to `main` and on pull requests, without AWS credentials. The integration tests need Docker and run locally.

## Results

### Concurrent allocation against DynamoDB Local

From [`results/local/concurrency.json`](results/local/concurrency.json), produced by `npm run local:race -- --runs 5` with DynamoDB Local 3.3.1 in Docker, Node v22.17.0, on a laptop with an i7-13700HX. Each run seeds 30 cars at a new station, creates 40 orders asking for 79 cars in total, and hands every order to two workers at the same moment, so 80 allocation calls start together.

| Across 5 runs | Result |
|---|---|
| cars held by more than one order | 0 |
| consistency check violations | 0 |
| orders left `PENDING` | 0 |
| cars allocated, of 30 | 30 in every run |
| allocation attempts for the 80 calls | median 186, range 174 to 194 |
| most attempts made by one call | median 4, range 3 to 4 |
| time for the allocation phase of a run | median 688 ms, range 590 to 819 ms |

An attempt is one index read plus one transaction, so more attempts than calls means workers did collide on cars and had to retry. None of those collisions gave a car to two orders. The integration test `test/integration/allocation.test.ts` runs the same race; with the `status = AVAILABLE` condition taken out of the transaction, that test fails.

### Configuration

From [`results/config.json`](results/config.json), produced by `npm run config:report`, which reads the values back from the synthesized CloudFormation template:

| Setting | Value |
|---|---|
| API methods that require a key | 3 of 3 |
| usage plan | 25 requests/s, burst 50, 20,000 requests a day |
| reserved concurrency | 5 for each API function, 2 for the worker |
| worker event source | batch size 5, maximum concurrency 2, failures reported per message |
| worker retries | up to 5 attempts per message before it goes back to the queue |
| queue | 60 s visibility timeout, 3 receives before the dead-letter queue, which keeps messages 14 days |
| functions | Node.js 22 on arm64, 512 MB, 10 s timeout |
| log retention | 7 days |
| alarms | DLQ depth at least 1 in a minute; oldest message over 300 s; at least 1 error per function in 5 minutes; at least 1 API 5xx in 5 minutes; API p99 over 1000 ms in 5 minutes |

### On AWS

Not measured yet: the stack has not been deployed. The scripts and what each one measures are described in [docs/deploy.md](docs/deploy.md), and their output will go in `results/live/`.

## Deploying and tearing down

The full steps, the IAM permissions and the measurement method are in [docs/deploy.md](docs/deploy.md). The short version:

```sh
export AWS_PROFILE=portfolio AWS_REGION=us-east-2
npm run live:preflight         # is there room for reserved concurrency?
npm run bootstrap              # once per account and region
npm run deploy
npm run live:load              # and live:cold, live:race, live:poison, then live:summary
npm run destroy
npm run live:verify-teardown   # confirms nothing from the stack is left
```

The deploy and measurement scripts remove account ids, ARNs and queue URLs from what they print, and refuse to write a results file that contains one.

## Known gaps

- An order stays `PENDING` if `SendMessage` fails after the order is written and the client never retries. The API answers 503 and asks for a retry with the same key, but nothing on the server notices if the client gives up. The RFC names the fix: an outbox through DynamoDB Streams and EventBridge Pipes.
- The API key limits cost; it does not identify a shipper. Any key holder can create orders for any `shipperId`.
- Loading dates are compared with the UTC date, so an order placed late in a US evening for the local "today" is refused.
- Allocation is all or nothing, and an `UNFILLED` order is not retried when cars arrive.

## License

[MIT](LICENSE)
