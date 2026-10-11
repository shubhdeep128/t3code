import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

export const ScheduledTaskTrigger = Schema.Literals(["scheduled", "manual", "webhook"]);
export type ScheduledTaskTrigger = typeof ScheduledTaskTrigger.Type;

/**
 * One firing of a scheduled task, written before it dispatches and settled
 * with the result, or written when it is skipped. Kept after the task is
 * deleted.
 */
export const ScheduledTaskFiring = Schema.Struct({
  fireKey: TrimmedNonEmptyString,
  taskId: ScheduledTaskId,
  trigger: ScheduledTaskTrigger,
  firedAt: IsoDateTime,
  /** Null when the dispatch failed or the firing was skipped. */
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  skipped: Schema.NullOr(Schema.Literal("previous_run_active")),
  /** Consecutive skips share one row; `firedAt` is the latest of them. Zero when it dispatched. */
  skippedCount: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
});
export type ScheduledTaskFiring = typeof ScheduledTaskFiring.Type;

/**
 * A firing with the outcome of the run its message started, followed through
 * restart continuations. A dispatch error reads `failed`, a skipped firing
 * `skipped`, and a run that can no longer be found `unknown`.
 */
export const ScheduledTaskFiringView = Schema.Struct({
  ...ScheduledTaskFiring.fields,
  status: Schema.Literals([...OrchestrationV2RunStatus.literals, "skipped", "unknown"]),
  completedAt: Schema.NullOr(IsoDateTime),
  /** The start of the run's last assistant message. */
  lastMessage: Schema.NullOr(Schema.String),
});
export type ScheduledTaskFiringView = typeof ScheduledTaskFiringView.Type;

export const ScheduledTaskListFiringsInput = Schema.Struct({
  taskId: Schema.optional(ScheduledTaskId),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
});
export type ScheduledTaskListFiringsInput = typeof ScheduledTaskListFiringsInput.Type;

export const ScheduledTaskListFiringsResult = Schema.Struct({
  /** Newest first. Run statuses grow over time, so one firing a client cannot read is dropped. */
  firings: ForwardCompatibleArray(ScheduledTaskFiringView),
});
export type ScheduledTaskListFiringsResult = typeof ScheduledTaskListFiringsResult.Type;
