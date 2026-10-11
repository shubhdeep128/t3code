import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
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
  dispatches = 0;
  failNextLaunch = false;
  /** The status a dispatched prompt's run starts in; `queued` when another run holds the thread. */
  dispatchedStatus: OrchestrationV2Run["status"] = "running";
  /** When set, a send reaches the thread, signals this, and never returns. */
  stallAfterSend: Deferred.Deferred<void> | undefined;

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

  update(threadId: ThreadId, runId: RunId, patch: Partial<OrchestrationV2Run>) {
    const thread = this.threads.get(threadId)!;
    thread.runs = thread.runs.map((run) => (run.id === runId ? { ...run, ...patch } : run));
  }

  finish(
    threadId: ThreadId,
    runId: RunId,
    status: OrchestrationV2Run["status"],
    reply: string,
    completedAt: string,
  ) {
    this.update(threadId, runId, { status, completedAt: DateTime.makeUnsafe(completedAt) });
    this.threads
      .get(threadId)!
      .messages.push(
        this.message(threadId, MessageId.make(`reply:${runId}`), runId, "assistant", reply),
      );
  }

  /** Deleting a thread keeps its records and cancels its unfinished runs. */
  delete(threadId: ThreadId, deletedAt: string) {
    for (const run of this.threads.get(threadId)!.runs) {
      if (!ThreadManagementService.isTerminalRunStatus(run.status)) {
        this.update(threadId, run.id, {
          status: "cancelled",
          completedAt: DateTime.makeUnsafe(deletedAt),
        });
      }
    }
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
          Effect.suspend(() => {
            this.dispatches += 1;
            this.start(input.threadId, input.messageId, { status: this.dispatchedStatus });
            return this.stallAfterSend === undefined
              ? Effect.succeed({ message: { threadId: input.threadId } } as never)
              : Deferred.succeed(this.stallAfterSend, undefined).pipe(Effect.andThen(Effect.never));
          }),
        getThreadRecords: (threadId, _fields, filter) => {
          const thread = this.threads.get(threadId);
          if (thread === undefined) {
            return Effect.fail(new OrchestratorProjectionError({ threadId }));
          }
          const runs = thread.runs.filter(
            (run) => filter?.runIds === undefined || filter.runIds.includes(run.id),
          );
          const messages = thread.messages.filter(
            (message) =>
              (filter?.messageIds === undefined || filter.messageIds.includes(message.id)) &&
              (filter?.messageRoles === undefined || filter.messageRoles.includes(message.role)) &&
              (filter?.messageRunIds === undefined ||
                (message.runId !== null && filter.messageRunIds.includes(message.runId))),
          );
          return Effect.succeed({ thread: { id: threadId }, runs, messages } as never);
        },
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) => {
          if (this.failNextLaunch) {
            this.failNextLaunch = false;
            return Effect.die(new Error("Provider instance is not installed."));
          }
          return Effect.sync(() => {
            this.dispatches += 1;
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

const withService = <A, E, R>(
  threads: FakeThreads,
  body: (service: ScheduledTaskService.ScheduledTaskService["Service"]) => Effect.Effect<A, E, R>,
) =>
  ScheduledTaskService.ScheduledTaskService.pipe(
    Effect.flatMap(body),
    Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(threads.dependencies()))),
  );

/** Waits until the persisted task list shows `done`. */
const awaitTask = (
  service: ScheduledTaskService.ScheduledTaskService["Service"],
  done: (task: ScheduledTask) => boolean,
) =>
  service.subscribeList().pipe(
    Stream.filter(({ tasks }) => tasks[0] !== undefined && done(tasks[0])),
    Stream.runHead,
  );

/**
 * Runs one scheduler pass at `seconds` past T0. Starting the service registers
 * its scheduler source, whose first pass runs at once, and the clock stays
 * frozen so no other pass runs. `done` is the persisted state that ends it.
 */
const passAt = (threads: FakeThreads, seconds: number, done: (task: ScheduledTask) => boolean) =>
  TestClock.setTime(T0 + seconds * 1000).pipe(
    Effect.andThen(withService(threads, (service) => awaitTask(service, done))),
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
          skippedCount: 0,
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

it.effect("skips firings while the previous run is queued or running, then fires again", () =>
  fromT0((threads) =>
    Effect.gen(function* () {
      threads.dispatchedStatus = "queued";
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
      const activeRunId = runIdOf(`${taskId}:${T0}:manual`);

      yield* passAt(threads, 60, (task) => task.nextRunAt === at(120));
      threads.update(BOUND_THREAD, activeRunId, { status: "running" });
      // The second pass looks past the skipped firings to the active run.
      yield* passAt(threads, 120, (task) => task.nextRunAt === at(180));
      threads.finish(BOUND_THREAD, activeRunId, "completed", "Done.", at(150));
      yield* passAt(threads, 180, (task) => task.runCount === 2);

      const { firings } = yield* withService(threads, (service) =>
        service.listFirings({ taskId, limit: 10 }),
      );
      assert.deepEqual(
        firings.map(({ trigger, firedAt, threadId, skipped, skippedCount, status }) => ({
          trigger,
          firedAt,
          threadId,
          skipped,
          skippedCount,
          status,
        })),
        [
          {
            trigger: "scheduled",
            firedAt: at(180),
            threadId: BOUND_THREAD,
            skipped: null,
            skippedCount: 0,
            status: "queued",
          },
          {
            trigger: "scheduled",
            firedAt: at(120),
            threadId: null,
            skipped: "previous_run_active",
            skippedCount: 2,
            status: "skipped",
          },
          {
            trigger: "manual",
            firedAt: at(1),
            threadId: null,
            skipped: "previous_run_active",
            skippedCount: 1,
            status: "skipped",
          },
          {
            trigger: "manual",
            firedAt: at(0),
            threadId: BOUND_THREAD,
            skipped: null,
            skippedCount: 0,
            status: "completed",
          },
        ],
      );
      assert.equal(threads.dispatches, 2);
    }),
  ),
);

it.effect("waits on a firing whose dispatch was cut off before it settled", () =>
  fromT0((threads) =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      threads.stallAfterSend = sent;
      yield* withService(threads, (service) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* taskInput());
          const dispatch = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
          yield* Deferred.await(sent);
          yield* Fiber.interrupt(dispatch);
        }),
      );
      threads.stallAfterSend = undefined;

      yield* passAt(threads, 60, (task) => task.nextRunAt === at(120));
      assert.equal(threads.dispatches, 1);
    }),
  ),
);

it.effect("waits for a restart continuation and reports the run it continued to", () =>
  fromT0((threads) =>
    withService(threads, (service) =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const { task } = yield* service.upsert(yield* taskInput());
        yield* service.runNow({ id: task.id });
        const cutRunId = runIdOf(`${task.id}:${T0}:manual`);
        const outcome = service.listFirings({ taskId: task.id, limit: 10 }).pipe(
          Effect.map(({ firings }) => {
            const firing = firings.findLast((candidate) => candidate.skipped === null);
            return [firing?.status, firing?.completedAt, firing?.lastMessage];
          }),
        );
        const runNowAfterASecond = TestClock.adjust("1 second").pipe(
          Effect.andThen(service.runNow({ id: task.id })),
        );

        // Recovery cancels the cut run and queues its continuation in one write.
        threads.finish(BOUND_THREAD, cutRunId, "cancelled", "Stopped by a restart.", at(30));
        const effectId = `effect:restart-continuation:${cutRunId}`;
        yield* outbox.enqueue([
          {
            id: effectId,
            commandId: CommandId.make("command:restart"),
            threadId: BOUND_THREAD,
            request: { type: "provider-runtime.continue", sourceRunId: cutRunId },
          },
        ]);
        assert.deepEqual(yield* outcome, ["cancelled", at(30), "Stopped by a restart."]);
        yield* runNowAfterASecond.pipe(Effect.flip);
        assert.equal(threads.dispatches, 1);

        const continuationId = threads.start(
          BOUND_THREAD,
          MessageId.make(`message:restart-continuation:${cutRunId}`),
          { restartContinuationOfRunId: cutRunId },
        );
        yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 60_000 });
        yield* outbox.succeed({ effectId, workerId: "test" });
        assert.deepEqual(yield* outcome, ["running", null, "Stopped by a restart."]);
        yield* runNowAfterASecond.pipe(Effect.flip);
        assert.equal(threads.dispatches, 1);

        threads.finish(BOUND_THREAD, continuationId, "completed", "Resumed and finished.", at(45));
        assert.deepEqual(yield* outcome, ["completed", at(45), "Resumed and finished."]);
        yield* runNowAfterASecond;
        assert.equal(threads.dispatches, 2);
      }),
    ).pipe(Effect.provide(EffectOutbox.layer)),
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
        // A deleted thread's cancelled run is over, so the next firing goes out.
        threads.delete(
          ThreadId.make(`thread:scheduled-task:${task.id}:${T0 + 1000}:manual`),
          at(2),
        );
        yield* TestClock.adjust("2 seconds");
        yield* service.runNow({ id: task.id });
        yield* service.delete({ id: task.id });

        const { firings } = yield* service.listFirings({ taskId: task.id, limit: 10 });
        assert.deepEqual(
          firings.map(({ firedAt, status, completedAt }) => ({ firedAt, status, completedAt })),
          [
            { firedAt: at(3), status: "running", completedAt: null },
            { firedAt: at(1), status: "cancelled", completedAt: at(2) },
            { firedAt: at(0), status: "failed", completedAt: null },
          ],
        );
        assert.include(firings[2]?.error, "Provider instance is not installed.");
      }),
    ),
  ),
);

it.effect("does not hold a recreated task behind the deleted task's run", () =>
  fromT0((threads) =>
    withService(threads, (service) =>
      Effect.gen(function* () {
        const input = yield* taskInput();
        const { task } = yield* service.upsert(input);
        yield* service.runNow({ id: task.id });
        yield* service.delete({ id: task.id });
        yield* TestClock.adjust("1 second");
        yield* service.upsert(input);
        yield* service.runNow({ id: task.id });
        assert.equal(threads.dispatches, 2);
      }),
    ),
  ),
);

it.effect("never skips a webhook delivery", () =>
  fromT0((threads) =>
    withService(threads, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          yield* taskInput({ threadId: null, schedule: { type: "webhook" } }),
        );
        const body = new TextEncoder().encode("{}");
        for (let delivery = 0; delivery < 2; delivery++) {
          yield* service.triggerWebhook({
            hookId: task.id,
            token: task.webhook?.path.split("/").at(-1) ?? "",
            method: "POST",
            path: task.webhook?.path ?? "",
            query: "",
            headers: { "content-type": "application/json" },
            body,
            bodyText: "{}",
          });
        }
        yield* awaitTask(service, (current) => current.runCount === 2);

        const { firings } = yield* service.listFirings({ taskId: task.id, limit: 10 });
        assert.deepEqual(
          firings.map(({ trigger, skipped, status }) => ({ trigger, skipped, status })),
          [
            { trigger: "webhook", skipped: null, status: "running" },
            { trigger: "webhook", skipped: null, status: "running" },
          ],
        );
        assert.equal(threads.dispatches, 2);
      }),
    ),
  ),
);
