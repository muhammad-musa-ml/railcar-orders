import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type { Logger } from "../log";
import { parseAllocationMessage } from "../queue";
import { type AllocatorDeps, allocateOrder } from "./allocate";

/**
 * Handles one SQS batch. Records run concurrently; each failure is reported on its own
 * (ReportBatchItemFailures), so only that message is retried and, after the queue's
 * maxReceiveCount, moved to the dead-letter queue.
 */
export async function processBatch(event: SQSEvent, deps: AllocatorDeps, log: Logger): Promise<SQSBatchResponse> {
  const results = await Promise.allSettled(event.Records.map((record) => processRecord(record, deps, log)));
  const batchItemFailures = results.flatMap((r, i) =>
    r.status === "rejected" ? [{ itemIdentifier: (event.Records[i] as SQSRecord).messageId }] : [],
  );
  return { batchItemFailures };
}

async function processRecord(record: SQSRecord, deps: AllocatorDeps, log: Logger): Promise<void> {
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? "1");
  const message = parseAllocationMessage(record.body);
  if (!message) {
    log.error("allocation.bad_message", { messageId: record.messageId, receiveCount, body: record.body.slice(0, 200) });
    throw new Error(`message ${record.messageId} is not an allocation message`);
  }

  const started = Date.now();
  try {
    const outcome = await allocateOrder(message.orderId, deps, log);
    log.info(`allocation.${outcome.result}`, {
      orderId: message.orderId,
      messageId: record.messageId,
      receiveCount,
      ...outcome,
      ms: Date.now() - started,
    });
    log.metrics({
      OrdersAllocated: outcome.result === "allocated" ? 1 : 0,
      OrdersUnfilled: outcome.result === "unfilled" ? 1 : 0,
      AllocationAttempts: outcome.attempts,
    });
  } catch (err) {
    log.error("allocation.failed", { orderId: message.orderId, messageId: record.messageId, receiveCount, err });
    throw err;
  }
}
