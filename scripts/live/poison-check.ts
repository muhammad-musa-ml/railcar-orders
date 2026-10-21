/**
 * Sends one message the worker cannot process and times its path: how long until SQS
 * moves it to the dead-letter queue, and how long until the DLQ alarm goes to ALARM.
 * Then it removes the message and waits for the alarm to return to OK, so runs can
 * follow each other.
 *
 *   AWS_PROFILE=portfolio npm run live:poison
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { stamp, writeResult } from "../lib/results";
import { REGION, requireProfile, sleep, stackOutputs } from "./aws";

const { values } = parseArgs({ options: { "timeout-minutes": { type: "string", default: "30" } } });
const timeoutMs = Number(values["timeout-minutes"]) * 60_000;

requireProfile();
const outputs = await stackOutputs();
const sqs = new SQSClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });
const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: outputs.QueueName }))).QueueUrl as string;
const dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: outputs.DlqName }))).QueueUrl as string;

async function alarmState(): Promise<{ state: string; updated?: Date }> {
  const res = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNames: [outputs.DlqAlarmName] }));
  const alarm = res.MetricAlarms?.[0];
  if (!alarm) throw new Error("DLQ alarm not found");
  return { state: alarm.StateValue ?? "UNKNOWN", updated: alarm.StateUpdatedTimestamp };
}

async function dlqDepth(): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

async function waitFor<T>(what: string, poll: () => Promise<T>, done: (v: T) => boolean, everyMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await poll();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Receives and deletes everything in the DLQ; returns the bodies. */
async function drainDlq(): Promise<string[]> {
  const bodies: string[] = [];
  for (let empty = 0; empty < 3; ) {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
    const msgs = res.Messages ?? [];
    if (msgs.length === 0) {
      empty++;
      continue;
    }
    bodies.push(...msgs.map((m) => m.Body ?? ""));
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: dlqUrl,
        Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle as string })),
      }),
    );
  }
  return bodies;
}

// Start from a clean state: empty DLQ, alarm OK.
const leftovers = await drainDlq();
const before = await waitFor("alarm OK before the run", alarmState, (a) => a.state === "OK", 15_000);

const marker = `poison-${randomUUID()}`;
const body = `this is not JSON (${marker})`;
const sentAt = Date.now();
await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
console.log(`sent poison message ${marker}`);

await waitFor("message in DLQ", dlqDepth, (n) => n >= 1, 5_000);
const inDlqAt = Date.now();
console.log(`in DLQ after ${Math.round((inDlqAt - sentAt) / 1000)} s`);

const alarm = await waitFor("DLQ alarm", alarmState, (a) => a.state === "ALARM", 10_000);
const alarmSeenAt = Date.now();
const alarmAt = alarm.updated ? alarm.updated.getTime() : alarmSeenAt;
console.log(`alarm in ALARM after ${Math.round((alarmAt - sentAt) / 1000)} s`);

const drained = await drainDlq();
const drainedAt = Date.now();
const found = drained.some((b) => b.includes(marker));
const ok = await waitFor("alarm back to OK", alarmState, (a) => a.state === "OK", 15_000);
const okAt = ok.updated ? ok.updated.getTime() : Date.now();

const result = {
  kind: "poison-message-check",
  region: REGION,
  sentAt: new Date(sentAt).toISOString(),
  alarmStateBefore: before.state,
  leftoverMessagesDrainedBeforeRun: leftovers.length,
  secondsToDlq: Math.round((inDlqAt - sentAt) / 1000),
  secondsToAlarm: Math.round((alarmAt - sentAt) / 1000),
  secondsFromDlqToAlarm: Math.round((alarmAt - inDlqAt) / 1000),
  secondsFromDrainToOk: Math.round((okAt - drainedAt) / 1000),
  poisonBodyFoundInDlq: found,
  notes: "secondsToAlarm uses the alarm's StateUpdatedTimestamp; DLQ arrival is polled every 5 s",
};
const path = writeResult(`live/poison/run-${stamp()}.json`, result);
console.log(JSON.stringify(result, null, 2));
console.log(`wrote ${path}`);
if (!found) process.exit(1);
