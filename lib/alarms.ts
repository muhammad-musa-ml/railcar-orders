import { Duration } from "aws-cdk-lib";
import type * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

/** Alarm thresholds. RFC 0001, "Observability". */
export const ALARMS = {
  dlqDepthMessages: 1,
  dlqPeriodSeconds: 60,
  oldestMessageSeconds: 300,
  errorsPerPeriod: 1,
  errorPeriodMinutes: 5,
  latencyP99Ms: 1000,
  latencyPeriodMinutes: 5,
} as const;

export interface AlarmTargets {
  api: apigw.RestApi;
  queue: sqs.Queue;
  dlq: sqs.Queue;
  functions: Record<string, lambda.IFunction>;
  alarmEmail?: string;
}

export interface Alarms {
  topic: sns.Topic;
  dlqDepth: cloudwatch.Alarm;
  all: cloudwatch.Alarm[];
}

export function addAlarms(scope: Construct, targets: AlarmTargets): Alarms {
  const topic = new sns.Topic(scope, "AlarmTopic", { enforceSSL: true });
  if (targets.alarmEmail) topic.addSubscription(new EmailSubscription(targets.alarmEmail));
  const action = new SnsAction(topic);
  const all: cloudwatch.Alarm[] = [];

  // An idle stack sends no data points; that is not a failure.
  const base = {
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  };
  const add = (alarm: cloudwatch.Alarm) => {
    alarm.addAlarmAction(action);
    alarm.addOkAction(action);
    all.push(alarm);
    return alarm;
  };

  const dlqDepth = add(
    targets.dlq
      .metricApproximateNumberOfMessagesVisible({
        period: Duration.seconds(ALARMS.dlqPeriodSeconds),
        statistic: cloudwatch.Stats.MAXIMUM,
      })
      .createAlarm(scope, "DlqDepthAlarm", {
        ...base,
        threshold: ALARMS.dlqDepthMessages,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: "A message failed allocation repeatedly and is in the dead-letter queue.",
      }),
  );

  add(
    targets.queue
      .metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1), statistic: cloudwatch.Stats.MAXIMUM })
      .createAlarm(scope, "QueueAgeAlarm", {
        ...base,
        threshold: ALARMS.oldestMessageSeconds,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: "Orders are waiting for allocation: the worker is stuck or throttled.",
      }),
  );

  for (const [name, fn] of Object.entries(targets.functions)) {
    add(
      fn
        .metricErrors({ period: Duration.minutes(ALARMS.errorPeriodMinutes), statistic: cloudwatch.Stats.SUM })
        .createAlarm(scope, `${name}ErrorsAlarm`, {
          ...base,
          threshold: ALARMS.errorsPerPeriod,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          alarmDescription: `${name} threw, timed out or ran out of memory.`,
        }),
    );
  }

  add(
    targets.api
      .metricServerError({ period: Duration.minutes(ALARMS.errorPeriodMinutes), statistic: cloudwatch.Stats.SUM })
      .createAlarm(scope, "Api5xxAlarm", {
        ...base,
        threshold: ALARMS.errorsPerPeriod,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: "The API returned a 5xx response.",
      }),
  );

  add(
    targets.api
      .metricLatency({ period: Duration.minutes(ALARMS.latencyPeriodMinutes), statistic: cloudwatch.Stats.p(99) })
      .createAlarm(scope, "ApiLatencyP99Alarm", {
        ...base,
        threshold: ALARMS.latencyP99Ms,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: "p99 API latency is above the target.",
      }),
  );

  return { topic, dlqDepth, all };
}
