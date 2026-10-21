# railcar-orders

Shippers order empty railcars for a loading date, and a worker assigns cars from inventory. Built on AWS Lambda, API Gateway, DynamoDB and SQS, deployed with the AWS CDK. All data in this repository is synthetic.

The design is in [docs/rfc/0001-car-order-allocation.md](docs/rfc/0001-car-order-allocation.md).

## Tests

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Integration tests run the handlers against DynamoDB Local in Docker:

```sh
npm run ddb:start
npm run test:integration
npm run ddb:stop
```
