import {
  ScheduledTaskFiring,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type RunId,
  type ScheduledTaskFiringView,
  type ScheduledTaskId,
  type ScheduledTaskListFiringsInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const LAST_MESSAGE_CHARS = 600;

interface FiringRow {
  readonly fire_key: string;
  readonly task_id: string;
  readonly trigger: string;
  readonly fired_at: string;
  readonly thread_id: string | null;
  readonly message_id: string | null;
  readonly skipped: string | null;
  readonly error: string | null;
}

const decodeFiring = Schema.decodeUnknownEffect(ScheduledTaskFiring);
const decodeRow = (row: FiringRow) =>
  decodeFiring({
    fireKey: row.fire_key,
    taskId: row.task_id,
    trigger: row.trigger,
    firedAt: row.fired_at,
    threadId: row.thread_id,
    messageId: row.message_id,
    skipped: row.skipped,
    error: row.error,
  });

/** The run a firing's message started, followed through restart continuations to the newest. */
interface FiringRun {
  readonly run: OrchestrationV2Run;
  readonly chain: ReadonlyArray<RunId>;
}

interface FiringOutcome {
  readonly run: OrchestrationV2Run;
  readonly lastMessage: string | null;
}

function resolveRuns(
  runs: ReadonlyArray<OrchestrationV2Run>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyMap<MessageId, FiringRun> {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const continuationOf = new Map<RunId, OrchestrationV2Run>();
  for (const run of runs) {
    const original = run.restartContinuationOfRunId;
    if (original === undefined) continue;
    const known = continuationOf.get(original);
    if (known === undefined || run.ordinal > known.ordinal) continuationOf.set(original, run);
  }
  const resolved = new Map<MessageId, FiringRun>();
  for (const message of messages) {
    let run = message.runId === null ? undefined : byId.get(message.runId);
    if (run === undefined) continue;
    const chain = [run.id];
    let next = continuationOf.get(run.id);
    while (next !== undefined && next.ordinal > run.ordinal) {
      run = next;
      chain.push(run.id);
      next = continuationOf.get(run.id);
    }
    resolved.set(message.id, { run, chain });
  }
  return resolved;
}

function toView(
  firing: ScheduledTaskFiring,
  outcome: FiringOutcome | undefined,
): ScheduledTaskFiringView {
  if (firing.skipped !== null || firing.error !== null || outcome === undefined) {
    const status =
      firing.skipped !== null ? "skipped" : firing.error !== null ? "failed" : "unknown";
    return { ...firing, status, completedAt: null, lastMessage: null };
  }
  const { status, completedAt } = outcome.run;
  return {
    ...firing,
    status,
    completedAt: completedAt === null ? null : DateTime.formatIso(completedAt),
    lastMessage: outcome.lastMessage,
  };
}

/**
 * The fork's record of scheduled task firings. Its table is created here, at
 * service start, not in a numbered migration: the migrator skips any number at
 * or below the highest applied, so a fork migration would swallow upstream's
 * next one.
 */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_watcher_firings (
      fire_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      skipped TEXT,
      error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_watcher_firings_task_fired_at
    ON fork_watcher_firings (task_id, fired_at)
  `;

  // A thread that cannot be read, usually because it was deleted, has no run
  // to report, so its firings read as unknown and never block the next one.
  const readThread = <A, E>(
    threadId: ThreadId,
    read: Effect.Effect<ReadonlyMap<MessageId, A>, E>,
  ) =>
    read.pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Could not read a scheduled task firing's thread", {
          threadId,
          cause,
        }).pipe(Effect.as(new Map<MessageId, A>())),
      ),
    );

  const resolveThread = (threadId: ThreadId, messageIds: ReadonlyArray<MessageId>) =>
    threads
      .getThreadRecords(threadId, ["runs", "messages"], { messageIds })
      .pipe(Effect.map(({ runs, messages }) => resolveRuns(runs, messages)));

  const outcomesInThread = (threadId: ThreadId, messageIds: ReadonlyArray<MessageId>) =>
    Effect.gen(function* () {
      const resolved = yield* resolveThread(threadId, messageIds);
      const chainRunIds = [...resolved.values()].flatMap(({ chain }) => chain);
      const replies =
        chainRunIds.length === 0
          ? []
          : (yield* threads.getThreadRecords(threadId, ["messages"], {
              messageRoles: ["assistant"],
              messageRunIds: chainRunIds,
            })).messages;
      const outcomes = new Map<MessageId, FiringOutcome>();
      for (const [messageId, { run, chain }] of resolved) {
        const reply = replies.findLast(
          (message) => message.runId !== null && chain.includes(message.runId),
        );
        outcomes.set(messageId, {
          run,
          lastMessage: reply === undefined ? null : reply.text.slice(0, LAST_MESSAGE_CHARS),
        });
      }
      return outcomes;
    });

  const record = (firing: ScheduledTaskFiring) =>
    sql`
      INSERT INTO fork_watcher_firings (
        fire_key, task_id, trigger, fired_at, thread_id, message_id, skipped, error
      )
      VALUES (
        ${firing.fireKey}, ${firing.taskId}, ${firing.trigger}, ${firing.firedAt},
        ${firing.threadId}, ${firing.messageId}, ${firing.skipped}, ${firing.error}
      )
      ON CONFLICT (fire_key) DO NOTHING
    `.pipe(Effect.asVoid);

  /** Whether the run started by the task's most recent dispatched firing is still going. */
  const previousRunActive = (taskId: ScheduledTaskId) =>
    Effect.gen(function* () {
      const rows = yield* sql<FiringRow>`
        SELECT * FROM fork_watcher_firings
        WHERE task_id = ${taskId} AND thread_id IS NOT NULL
        ORDER BY fired_at DESC, rowid DESC
        LIMIT 1
      `;
      if (rows[0] === undefined) return false;
      const { threadId, messageId } = yield* decodeRow(rows[0]);
      if (threadId === null || messageId === null) return false;
      const resolved = yield* readThread(threadId, resolveThread(threadId, [messageId]));
      const run = resolved.get(messageId)?.run;
      return run !== undefined && !ThreadManagementService.isTerminalRunStatus(run.status);
    });

  /** Newest first, each with the outcome of the run it started. */
  const list = (input: ScheduledTaskListFiringsInput) =>
    Effect.gen(function* () {
      const rows = yield* sql<FiringRow>`
        SELECT * FROM fork_watcher_firings
        ${input.taskId === undefined ? sql`` : sql`WHERE task_id = ${input.taskId}`}
        ORDER BY fired_at DESC, rowid DESC
        LIMIT ${input.limit}
      `;
      const firings = yield* Effect.forEach(rows, decodeRow);
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const { threadId, messageId } of firings) {
        if (threadId === null || messageId === null) continue;
        const messageIds = messageIdsByThread.get(threadId) ?? [];
        messageIds.push(messageId);
        messageIdsByThread.set(threadId, messageIds);
      }
      const outcomesByThread = yield* Effect.forEach(messageIdsByThread, ([threadId, messageIds]) =>
        readThread(threadId, outcomesInThread(threadId, messageIds)),
      );
      const outcomes = new Map(outcomesByThread.flatMap((byMessage) => [...byMessage]));
      return firings.map((firing) =>
        toView(firing, firing.messageId === null ? undefined : outcomes.get(firing.messageId)),
      );
    });

  return { record, previousRunActive, list };
});
