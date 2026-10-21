import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface AllocationMessage {
  orderId: string;
}

export interface OrderQueue {
  send(message: AllocationMessage): Promise<void>;
}

export class SqsOrderQueue implements OrderQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(message: AllocationMessage): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message) }));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Returns the message, or undefined when the body is not an allocation message. */
export function parseAllocationMessage(body: string): AllocationMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { orderId } = parsed as Record<string, unknown>;
  return isOrderId(orderId) ? { orderId } : undefined;
}
