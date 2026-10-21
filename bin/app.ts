import { App } from "aws-cdk-lib";
import { RailcarOrdersStack } from "../lib/railcar-orders-stack";

const app = new App();

// `cdk deploy -c reservedConcurrency=false` for accounts whose concurrency quota
// leaves nothing to reserve. scripts/live/preflight.ts reads the quota and says which to use.
const reserved = app.node.tryGetContext("reservedConcurrency");

new RailcarOrdersStack(app, "RailcarOrders", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
  reservedConcurrency: !(reserved === false || reserved === "false"),
  tags: { project: "railcar-orders" },
});
