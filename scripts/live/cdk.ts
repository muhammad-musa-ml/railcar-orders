/**
 * Runs the CDK CLI with the profile from AWS_PROFILE and redacts account ids, ARNs and
 * queue URLs from everything it prints. `cdk deploy` prints the stack ARN, which holds
 * the account id.
 *
 *   AWS_PROFILE=portfolio npm run cdk -- deploy --require-approval never
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { redact } from "../lib/results";
import { REGION, requireProfile } from "./aws";

const profile = requireProfile();
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: npm run cdk -- <bootstrap|deploy|destroy|diff> [options]");
  process.exit(2);
}

const child = spawn("npx", ["cdk", ...args, "--profile", profile], {
  env: { ...process.env, AWS_REGION: REGION, CDK_DEFAULT_REGION: REGION, FORCE_COLOR: "0" },
  shell: process.platform === "win32",
  stdio: ["inherit", "pipe", "pipe"],
});

for (const [stream, out] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
] as const) {
  createInterface({ input: stream }).on("line", (line) => out.write(`${redact(line)}\n`));
}

child.on("close", (code) => process.exit(code ?? 1));
