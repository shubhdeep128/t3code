import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ScheduledTaskFirings from "../../../scheduledTasks/ScheduledTaskFirings.ts";
import * as FindingService from "../../../watchers/FindingService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const WATCHER = ThreadId.make("thread:watcher");
const TASK = ScheduledTaskId.make("scheduled-task:perf");
const FIRE_KEY = "scheduled-task:perf:1760173200000:scheduled";
const FIRING_MESSAGE = MessageId.make(`scheduled-task-message:${FIRE_KEY}`);

const run = (ordinal: number, userMessageId: MessageId, extra: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: RunId.make(`run:${ordinal}`),
    threadId: WATCHER,
    ordinal,
    userMessageId,
    status: "running",
    ...extra,
  }) as OrchestrationV2Run;

/** The watcher thread mid-turn in its newest run. */
const layerWatcherThread = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(liveThreadShell(threadId, { activeRunId: runs.at(-1)?.id ?? null })),
    getThreadRecords: (_threadId, _fields, filter) =>
      Effect.succeed({
        runs: runs.filter((candidate) => filter?.runIds?.includes(candidate.id) ?? true),
      } as never),
  });

const caller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:here"),
  requestNamespace: "provider:watcher",
  thread: {
    threadId: WATCHER,
    providerSessionId: "provider:watcher",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "watcher", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "watcher", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** Records one settled firing of the task, then reports a finding from the watcher through /mcp. */
const reportFromWatcher = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  Effect.gen(function* () {
    const firings = yield* ScheduledTaskFirings.make;
    yield* firings.begin(
      {
        fireKey: FIRE_KEY,
        task: { id: TASK, createdAt: "2026-10-01T09:00:00.000Z" },
        trigger: "scheduled",
        firedAt: "2026-10-11T09:00:00.000Z",
      },
      { threadId: WATCHER, messageId: FIRING_MESSAGE },
    );
    yield* firings.settle(FIRE_KEY, { threadId: WATCHER, messageId: FIRING_MESSAGE, error: null });
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({
        name: "report_finding",
        arguments: {
          fingerprint: "slow:checkout:p95",
          title: "Checkout is slow",
          detail: "p95 is 4 seconds.",
          severity: "medium",
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  }).pipe(
    Effect.provide(
      McpHttpServer.layerWatchersToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(FindingService.layer),
        Layer.provideMerge(layerWatcherThread(runs)),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(caller.environmentId),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  );

it.effect("a finding reported from a scheduled task's run names the firing", () =>
  Effect.gen(function* () {
    const result = yield* reportFromWatcher([run(1, FIRING_MESSAGE)]);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      created: true,
      finding: { source: { type: "scheduled_task", taskId: TASK, fireKey: FIRE_KEY } },
    });
  }),
);

it.effect("a restart continuation of a firing's run still names the firing", () =>
  Effect.gen(function* () {
    const result = yield* reportFromWatcher([
      run(1, FIRING_MESSAGE, { status: "cancelled" }),
      run(2, MessageId.make("message:continue"), {
        restartContinuationOfRunId: RunId.make("run:1"),
      }),
    ]);

    expect(result.structuredContent).toMatchObject({
      finding: { source: { type: "scheduled_task", taskId: TASK, fireKey: FIRE_KEY } },
    });
  }),
);

it.effect("a finding reported from a run the user started names the thread", () =>
  Effect.gen(function* () {
    const result = yield* reportFromWatcher([
      run(1, FIRING_MESSAGE, { status: "completed" }),
      run(2, MessageId.make("message:user")),
    ]);

    expect(result.structuredContent).toMatchObject({
      finding: { source: { type: "thread", threadId: WATCHER } },
    });
  }),
);
