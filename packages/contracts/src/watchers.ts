import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
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

export const FindingId = TrimmedNonEmptyString.pipe(Schema.brand("FindingId"));
export type FindingId = typeof FindingId.Type;

/** The thread working on a finding, in whichever environment it runs. */
export const WorkThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type WorkThreadRef = typeof WorkThreadRef.Type;

/** Derived on the server from the reporting thread, never passed by the reporter. */
export const FindingSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("scheduled_task"),
    taskId: ScheduledTaskId,
    fireKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type FindingSource = typeof FindingSource.Type;

export const FindingSeverity = Schema.Literals(["high", "medium", "low"]);
export type FindingSeverity = typeof FindingSeverity.Type;

/** Only the user's decision is stored. How the work is going is derived from the work thread. */
export const FindingTriage = Schema.Literals(["open", "backlog", "dismissed"]);
export type FindingTriage = typeof FindingTriage.Type;

/**
 * A problem a watcher noticed. Reports with the same fingerprint in a project
 * collapse into one finding until its work merges.
 */
export const Finding = Schema.Struct({
  findingId: FindingId,
  projectId: ProjectId,
  fingerprint: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  /** Markdown evidence. May name other findings by id. */
  detail: Schema.String,
  severity: FindingSeverity,
  source: FindingSource,
  triage: FindingTriage,
  workThread: Schema.NullOr(WorkThreadRef),
  /**
   * Bumped by every claim. A worker's thread and command ids derive from it,
   * so a retried launch lands on the same thread.
   */
  workAttempt: NonNegativeInt,
  /** Set once by a client that sees the work merge, for work this server cannot read. */
  workMergedAt: Schema.NullOr(IsoDateTime),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  seenCount: PositiveInt,
});
export type Finding = typeof Finding.Type;

export const FindingsListInput = Schema.Struct({
  /** Every project when omitted. */
  projectId: Schema.optional(ProjectId),
  triage: Schema.optional(FindingTriage),
  /** Only findings last seen at or after this time. */
  since: Schema.optional(IsoDateTime),
  /** Matches the title, detail or fingerprint, ignoring case. */
  query: Schema.optional(TrimmedNonEmptyString),
  /** 500 when omitted. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type FindingsListInput = typeof FindingsListInput.Type;

export const FindingsListResult = Schema.Struct({
  /** Newest first. */
  findings: ForwardCompatibleArray(Finding),
});
export type FindingsListResult = typeof FindingsListResult.Type;

export const FindingsSubscribeInput = Schema.Struct({});
export type FindingsSubscribeInput = typeof FindingsSubscribeInput.Type;

export const FindingsUpdateInput = Schema.Struct({
  findingId: FindingId,
  triage: Schema.optional(FindingTriage),
  /**
   * Sets the work thread, or detaches it with null, only if `workAttempt` is
   * still `expectedWorkAttempt`, so two clients cannot both claim a finding.
   * New work has not merged, so a claim clears `workMergedAt` unless one is given.
   */
  claim: Schema.optional(
    Schema.Struct({
      workThread: Schema.NullOr(WorkThreadRef),
      expectedWorkAttempt: NonNegativeInt,
    }),
  ),
  /** Kept from the first write until the next claim. */
  workMergedAt: Schema.optional(IsoDateTime),
});
export type FindingsUpdateInput = typeof FindingsUpdateInput.Type;

export const FindingsUpdateResult = Schema.Struct({ finding: Finding });
export type FindingsUpdateResult = typeof FindingsUpdateResult.Type;

export class FindingError extends Schema.TaggedError<FindingError>()("FindingError", {
  message: Schema.String,
  findingId: Schema.optional(FindingId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A claim lost to one that changed the finding's work first. */
export class FindingClaimConflict extends Schema.TaggedError<FindingClaimConflict>()(
  "FindingClaimConflict",
  {
    findingId: FindingId,
    expectedWorkAttempt: NonNegativeInt,
    workAttempt: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Finding ${this.findingId} was claimed at attempt ${this.workAttempt}, not ${this.expectedWorkAttempt}.`;
  }
}
