import {
  MessageId,
  ScheduledTaskFiring,
  type OrchestrationV2Run,
  type RunId,
  type ScheduledTask,
  type ScheduledTaskFiringView,
  type ScheduledTaskListFiringsInput,
  type ScheduledTaskTrigger,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const LAST_MESSAGE_CHARS = 600;

/** What runTask knows about a firing before it dispatches or skips. */
export interface FiringStart {
  readonly fireKey: string;
  readonly task: Pick<ScheduledTask, "id" | "createdAt">;
  readonly trigger: ScheduledTaskTrigger;
  readonly firedAt: string;
}

interface FiringRow {
  readonly fire_key: string;
  readonly task_id: string;
  readonly trigger: string;
  readonly fired_at: string;
  readonly thread_id: string | null;
  readonly message_id: string | null;
  readonly skipped: string | null;
  readonly skipped_count: number;
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
    skippedCount: row.skipped_count,
    error: row.error,
  });

// Restart recovery names a continuation after the run it continues.
const continuationMessageId = (runId: RunId) =>
  MessageId.make(`message:restart-continuation:${runId}`);
const continuationEffectId = (runId: RunId) => `effect:restart-continuation:${runId}`;

/** The run a firing's message started, followed through restart continuations to the newest. */
interface FiringRun {
  readonly run: OrchestrationV2Run;
  readonly chain: ReadonlyArray<RunId>;
}

interface FiringOutcome {
  readonly run: OrchestrationV2Run;
  readonly lastMessage: string | null;
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
      task_created_at TEXT NOT NULL,
      trigger TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      skipped TEXT,
      skipped_count INTEGER NOT NULL,
      error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_watcher_firings_task_fired_at
    ON fork_watcher_firings (task_id, fired_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_watcher_firings_message_id
    ON fork_watcher_firings (message_id)
  `;

  // A thread whose records cannot be read reports no run, so its firings read
  // as unknown and never block the next one.
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

  /**
   * Follows each message to its run and, when that run was cancelled, on to
   * the run that continued it after a restart. Reads only the runs it follows.
   */
  const resolveRuns = (threadId: ThreadId, messageIds: ReadonlyArray<MessageId>) =>
    Effect.gen(function* () {
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], { messageIds });
      let following = new Map<MessageId, { head: RunId; chain: ReadonlyArray<RunId> }>();
      for (const message of messages) {
        if (message.runId !== null) {
          following.set(message.id, { head: message.runId, chain: [message.runId] });
        }
      }
      const resolved = new Map<MessageId, FiringRun>();
      while (following.size > 0) {
        const heads = [...new Set([...following.values()].map(({ head }) => head))];
        const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"], {
          runIds: heads,
          messageIds: heads.map(continuationMessageId),
        });
        const next = new Map<MessageId, { head: RunId; chain: ReadonlyArray<RunId> }>();
        for (const [messageId, { head, chain }] of following) {
          const run = records.runs.find((candidate) => candidate.id === head);
          if (run === undefined) continue;
          const continuedBy =
            run.status === "cancelled"
              ? records.messages.find((message) => message.id === continuationMessageId(head))
                  ?.runId
              : undefined;
          if (continuedBy != null && !chain.includes(continuedBy)) {
            next.set(messageId, { head: continuedBy, chain: [...chain, continuedBy] });
          } else {
            resolved.set(messageId, { run, chain });
          }
        }
        following = next;
      }
      return resolved;
    });

  const outcomesInThread = (threadId: ThreadId, messageIds: ReadonlyArray<MessageId>) =>
    Effect.gen(function* () {
      const resolved = yield* resolveRuns(threadId, messageIds);
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

  /** Written before dispatch, so a crash or a failed write cannot drop the next firing's guard. */
  const begin = (
    start: FiringStart,
    sent: { readonly threadId: ThreadId | null; readonly messageId: MessageId },
  ) =>
    sql`
      INSERT INTO fork_watcher_firings (
        fire_key, task_id, task_created_at, trigger, fired_at,
        thread_id, message_id, skipped, skipped_count, error
      )
      VALUES (
        ${start.fireKey}, ${start.task.id}, ${start.task.createdAt}, ${start.trigger},
        ${start.firedAt}, ${sent.threadId}, ${sent.messageId}, NULL, 0, NULL
      )
      ON CONFLICT (fire_key) DO NOTHING
    `.pipe(Effect.asVoid);

  const settle = (
    fireKey: string,
    result: Pick<ScheduledTaskFiring, "threadId" | "messageId" | "error">,
  ) =>
    sql`
      UPDATE fork_watcher_firings
      SET thread_id = ${result.threadId}, message_id = ${result.messageId}, error = ${result.error}
      WHERE fire_key = ${fireKey}
    `.pipe(Effect.asVoid);

  /** A task blocked by one run keeps one row per trigger: the latest skip bumps its count. */
  const skip = (start: FiringStart) =>
    Effect.gen(function* () {
      const bumped = yield* sql<{ fire_key: string }>`
        UPDATE fork_watcher_firings
        SET fired_at = ${start.firedAt}, skipped_count = skipped_count + 1
        WHERE fire_key = (
          SELECT fire_key FROM fork_watcher_firings
          WHERE task_id = ${start.task.id} AND task_created_at = ${start.task.createdAt}
          ORDER BY fired_at DESC, rowid DESC
          LIMIT 1
        )
          AND skipped IS NOT NULL
          AND trigger = ${start.trigger}
        RETURNING fire_key
      `;
      if (bumped.length > 0) return;
      yield* sql`
        INSERT INTO fork_watcher_firings (
          fire_key, task_id, task_created_at, trigger, fired_at,
          thread_id, message_id, skipped, skipped_count, error
        )
        VALUES (
          ${start.fireKey}, ${start.task.id}, ${start.task.createdAt}, ${start.trigger},
          ${start.firedAt}, NULL, NULL, 'previous_run_active', 1, NULL
        )
        ON CONFLICT (fire_key) DO NOTHING
      `;
    });

  /**
   * Whether the run started by this task's most recent dispatched firing is
   * still going. A task deleted and recreated under the same id starts fresh.
   */
  const previousRunActive = (task: Pick<ScheduledTask, "id" | "createdAt">) =>
    Effect.gen(function* () {
      const rows = yield* sql<FiringRow>`
        SELECT * FROM fork_watcher_firings
        WHERE task_id = ${task.id} AND task_created_at = ${task.createdAt}
          AND message_id IS NOT NULL
        ORDER BY fired_at DESC, rowid DESC
        LIMIT 1
      `;
      if (rows[0] === undefined) return false;
      const { threadId, messageId } = yield* decodeRow(rows[0]);
      if (threadId === null || messageId === null) return false;
      const resolved = yield* readThread(threadId, resolveRuns(threadId, [messageId]));
      const run = resolved.get(messageId)?.run;
      if (run === undefined) return false;
      if (!ThreadManagementService.isTerminalRunStatus(run.status)) return true;
      if (run.status !== "cancelled") return false;
      // Restart recovery cancels the run it cut and queues its continuation in
      // the same write, so until that job settles the run is not over.
      const continuation = yield* sql<{ effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE effect_id = ${continuationEffectId(run.id)} AND status IN ('pending', 'running')
      `;
      return continuation.length > 0;
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
      const outcomesByThread = yield* Effect.forEach(
        messageIdsByThread,
        ([threadId, messageIds]) => readThread(threadId, outcomesInThread(threadId, messageIds)),
        { concurrency: 4 },
      );
      const outcomes = new Map(outcomesByThread.flatMap((byMessage) => [...byMessage]));
      return firings.map((firing) =>
        toView(firing, firing.messageId === null ? undefined : outcomes.get(firing.messageId)),
      );
    });

  /** The firing whose prompt is this message, which is how a run finds the firing that started it. */
  const firingForMessage = (messageId: MessageId) =>
    Effect.gen(function* () {
      const [row] = yield* sql<FiringRow>`
        SELECT * FROM fork_watcher_firings WHERE message_id = ${messageId} LIMIT 1
      `;
      return row === undefined ? undefined : yield* decodeRow(row);
    });

  return { begin, settle, skip, previousRunActive, list, firingForMessage };
});
