import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const T0 = Date.parse("2026-10-11T09:00:00.000Z");
const at = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(T0 + seconds * 1000));
const BOUND_THREAD = ThreadId.make("thread:bound");

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    id: "scheduled-task:watch",
    title: "Watch the logs",
    prompt: "Check the logs.",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: "project-watch",
    threadId: BOUND_THREAD,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

/** In-memory threads standing in for the orchestration projection the firings read. */
class FakeThreads {
  readonly threads = new Map<
    ThreadId,
    { runs: Array<OrchestrationV2Run>; messages: Array<OrchestrationV2ConversationMessage> }
  >();
  sends = 0;
  failNextLaunch = false;

  start(threadId: ThreadId, messageId: MessageId, extra: Partial<OrchestrationV2Run> = {}) {
    const thread = this.threads.get(threadId) ?? { runs: [], messages: [] };
    this.threads.set(threadId, thread);
    const run = {
      id: RunId.make(`run:${messageId}`),
      threadId,
      ordinal: thread.runs.length + 1,
      status: "running",
      completedAt: null,
      ...extra,
    } as OrchestrationV2Run;
    thread.runs.push(run);
    thread.messages.push(this.message(threadId, messageId, run.id, "user", "prompt"));
    return run.id;
  }

  finish(
    threadId: ThreadId,
    runId: RunId,
    status: OrchestrationV2Run["status"],
    reply: string,
    completedAt: string,
  ) {
    const thread = this.threads.get(threadId)!;
    thread.runs = thread.runs.map((run) =>
      run.id === runId ? { ...run, status, completedAt: DateTime.makeUnsafe(completedAt) } : run,
    );
    thread.messages.push(
      this.message(threadId, MessageId.make(`reply:${runId}`), runId, "assistant", reply),
    );
  }

  private message(
    threadId: ThreadId,
    id: MessageId,
    runId: RunId,
    role: "user" | "assistant",
    text: string,
  ) {
    return { id, threadId, runId, role, text } as OrchestrationV2ConversationMessage;
  }

  dependencies() {
    return Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            this.sends += 1;
            this.start(input.threadId, input.messageId);
            return { message: { threadId: input.threadId } } as never;
          }),
        getThreadRecords: (threadId, _fields, filter) => {
          const thread = this.threads.get(threadId);
          if (thread === undefined) {
            return Effect.fail(new OrchestratorProjectionError({ threadId }));
          }
          const messages = thread.messages.filter(
            (message) =>
              (filter?.messageIds === undefined || filter.messageIds.includes(message.id)) &&
              (filter?.messageRoles === undefined || filter.messageRoles.includes(message.role)) &&
              (filter?.messageRunIds === undefined ||
                (message.runId !== null && filter.messageRunIds.includes(message.runId))),
          );
          return Effect.succeed({ thread: { id: threadId }, runs: thread.runs, messages } as never);
        },
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) => {
          if (this.failNextLaunch) {
            this.failNextLaunch = false;
            return Effect.die(new Error("Provider instance is not installed."));
          }
          return Effect.sync(() => {
            const threadId = ThreadId.make(`thread:${input.commandId}`);
            this.start(threadId, input.initialMessage!.messageId!);
            return { threadId, resumed: false } as never;
          });
        },
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      NodeCrypto.layer,
      Scheduler.layer,
    );
  }
}

const withService = <A, E>(
  threads: FakeThreads,
  body: (service: ScheduledTaskService.ScheduledTaskService["Service"]) => Effect.Effect<A, E>,
) =>
  ScheduledTaskService.ScheduledTaskService.pipe(
    Effect.flatMap(body),
    Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(threads.dependencies()))),
  );

/**
 * Runs one scheduler pass at `seconds` past T0. Starting the service registers
 * its scheduler source, whose first pass runs at once, and the clock stays
 * frozen so no other pass runs. `done` is the persisted state that ends it.
 */
const passAt = (threads: FakeThreads, seconds: number, done: (task: ScheduledTask) => boolean) =>
  TestClock.setTime(T0 + seconds * 1000).pipe(
    Effect.andThen(
      withService(threads, (service) =>
        service.subscribeList().pipe(
          Stream.filter(({ tasks }) => tasks[0] !== undefined && done(tasks[0])),
          Stream.runHead,
        ),
      ),
    ),
  );

const runIdOf = (fireKey: string) => RunId.make(`run:scheduled-task-message:${fireKey}`);

/**
 * Starts a test at T0 on a fresh database. The clock is set before any
 * scheduler starts, or its loop would replay every tick since 1970.
 */
const fromT0 = <A, E, R>(body: (threads: FakeThreads) => Effect.Effect<A, E, R>) =>
  TestClock.setTime(T0).pipe(
    Effect.andThen(body(new FakeThreads())),
    Effect.provide(SqlitePersistence.layerMemory),
  );

it.effect("records a dispatched firing with its message id and the run's real status", () =>
  fromT0((threads) =>
    withService(threads, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* taskInput());
        yield* service.runNow({ id: task.id });

        const fireKey = `scheduled-task:watch:${T0}:manual`;
        const dispatched = {
          fireKey,
          taskId: task.id,
          trigger: "manual" as const,
          firedAt: at(0),
          threadId: BOUND_THREAD,
          messageId: MessageId.make(`scheduled-task-message:${fireKey}`),
          skipped: null,
          error: null,
        };
        assert.deepEqual(yield* service.listFirings({ taskId: task.id, limit: 10 }), {
          firings: [{ ...dispatched, status: "running", completedAt: null, lastMessage: null }],
        });

        threads.finish(
          BOUND_THREAD,
          runIdOf(fireKey),
          "completed",
          "No new errors in the last hour.",
          at(90),
        );
        assert.deepEqual(yield* service.listFirings({ taskId: task.id, limit: 10 }), {
          firings: [
            {
              ...dispatched,
              status: "completed",
              completedAt: at(90),
              lastMessage: "No new errors in the last hour.",
            },
          ],
        });
      }),
    ),
  ),
);

it.effect("skips firings while the previous dispatched run is active, then fires again", () =>
  fromT0((threads) =>
    Effect.gen(function* () {
      const taskId = yield* withService(threads, (service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* taskInput());
          yield* service.runNow({ id: task.id });
          yield* TestClock.adjust("1 second");
          const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
          assert.nestedPropertyVal(
            refused,
            "cause.message",
            "The previous run of this task is still active.",
          );
          return task.id;
        }),
      );

      // The second pass must look past the first skipped firing to the active run.
      yield* passAt(threads, 60, (task) => task.nextRunAt === at(120));
      yield* passAt(threads, 120, (task) => task.nextRunAt === at(180));
      threads.finish(
        BOUND_THREAD,
        runIdOf(`${taskId}:${T0}:manual`),
        "completed",
        "Done.",
        at(150),
      );
      yield* passAt(threads, 180, (task) => task.runCount === 2);

      const { firings } = yield* withService(threads, (service) =>
        service.listFirings({ taskId, limit: 10 }),
      );
      assert.deepEqual(
        firings.map(({ trigger, firedAt, threadId, skipped, status }) => ({
          trigger,
          firedAt,
          threadId,
          skipped,
          status,
        })),
        [
          {
            trigger: "scheduled",
            firedAt: at(180),
            threadId: BOUND_THREAD,
            skipped: null,
            status: "running",
          },
          {
            trigger: "scheduled",
            firedAt: at(120),
            threadId: null,
            skipped: "previous_run_active",
            status: "skipped",
          },
          {
            trigger: "scheduled",
            firedAt: at(60),
            threadId: null,
            skipped: "previous_run_active",
            status: "skipped",
          },
          {
            trigger: "manual",
            firedAt: at(1),
            threadId: null,
            skipped: "previous_run_active",
            status: "skipped",
          },
          {
            trigger: "manual",
            firedAt: at(0),
            threadId: BOUND_THREAD,
            skipped: null,
            status: "completed",
          },
        ],
      );
      assert.equal(threads.sends, 2);
    }),
  ),
);

it.effect("follows a cancelled run to its restart continuation", () =>
  fromT0((threads) =>
    withService(threads, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* taskInput());
        yield* service.runNow({ id: task.id });
        const originalRunId = runIdOf(`${task.id}:${T0}:manual`);
        const outcome = service.listFirings({ taskId: task.id, limit: 10 }).pipe(
          Effect.map(({ firings }) => {
            const firing = firings.findLast((candidate) => candidate.skipped === null);
            return [firing?.status, firing?.completedAt, firing?.lastMessage];
          }),
        );

        threads.finish(BOUND_THREAD, originalRunId, "cancelled", "Stopped by a restart.", at(30));
        assert.deepEqual(yield* outcome, ["cancelled", at(30), "Stopped by a restart."]);

        const continuationId = threads.start(BOUND_THREAD, MessageId.make("restart-continuation"), {
          restartContinuationOfRunId: originalRunId,
        });
        assert.deepEqual(yield* outcome, ["running", null, "Stopped by a restart."]);
        // The continuation is the previous run now, so the next firing waits for it.
        yield* TestClock.adjust("1 second");
        yield* service.runNow({ id: task.id }).pipe(Effect.flip);
        assert.equal(threads.sends, 1);

        threads.finish(BOUND_THREAD, continuationId, "completed", "Resumed and finished.", at(45));
        assert.deepEqual(yield* outcome, ["completed", at(45), "Resumed and finished."]);
      }),
    ),
  ),
);

it.effect("keeps firings after the task is deleted", () =>
  fromT0((threads) =>
    withService(threads, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(yield* taskInput({ threadId: null }));
        threads.failNextLaunch = true;
        yield* service.runNow({ id: task.id });
        yield* TestClock.adjust("1 second");
        yield* service.runNow({ id: task.id });
        // The thread the task launched is deleted along with the task.
        threads.threads.clear();
        yield* service.delete({ id: task.id });

        const { firings } = yield* service.listFirings({ taskId: task.id, limit: 10 });
        assert.deepEqual(
          firings.map(({ threadId, status }) => ({ threadId, status })),
          [
            {
              threadId: `thread:scheduled-task:${task.id}:${T0 + 1000}:manual`,
              status: "unknown",
            },
            { threadId: null, status: "failed" },
          ],
        );
        assert.include(firings[1]?.error, "Provider instance is not installed.");
      }),
    ),
  ),
);
