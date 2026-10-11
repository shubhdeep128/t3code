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
  type OrchestrationV2ThreadShell,
  type ThreadPullRequestLink,
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

/** Threads in `shells` as given, and every other thread mid-turn in the newest of `runs`. */
const layerWatcherThread = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map(),
) =>
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        shells.get(threadId) ?? liveThreadShell(threadId, { activeRunId: runs.at(-1)?.id ?? null }),
      ),
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

const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const layerTools = (threads: ReturnType<typeof layerWatcherThread>) =>
  McpHttpServer.layerWatchersToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(FindingService.layer),
    Layer.provideMerge(threads),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(caller.environmentId),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const slowCheckout = {
  fingerprint: "slow:checkout:p95",
  title: "Checkout is slow",
  detail: "p95 is 4 seconds.",
  severity: "medium",
};

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
    return yield* callTool("report_finding", slowCheckout);
  }).pipe(Effect.provide(layerTools(layerWatcherThread(runs))));

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

it.effect("list_findings and report_finding return the progress of each finding's work", () => {
  const worker = ThreadId.make("thread:worker");
  const readyPullRequest: ThreadPullRequestLink = {
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    source: "agent",
    linkedAt: "2026-10-11T10:00:00.000Z",
    snapshot: {
      state: "open",
      title: "Speed up checkout",
      headBranch: "fix/slow-checkout",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-10-11T11:00:00.000Z",
      reviewDecision: "approved",
      checksState: "passing",
      mergeability: "mergeable",
    },
    stack: null,
  };
  const shells = new Map([
    [
      worker,
      {
        ...liveThreadShell(worker, { activeRunId: null }),
        status: "completed" as const,
        branch: "fix/slow-checkout",
        pullRequests: [readyPullRequest],
      },
    ],
  ]);
  return Effect.gen(function* () {
    yield* callTool("report_finding", slowCheckout);
    yield* callTool("report_finding", { ...slowCheckout, fingerprint: "slow:search:p95" });
    const findings = yield* FindingService.FindingService;
    const claim = (fingerprint: string, environmentId: EnvironmentId) =>
      findings.list({ query: fingerprint }).pipe(
        Effect.flatMap(({ findings: matched }) =>
          Effect.forEach(matched, ({ findingId }) =>
            findings.update({
              findingId,
              claim: { workThread: { environmentId, threadId: worker }, expectedWorkAttempt: 0 },
            }),
          ),
        ),
      );
    yield* claim("slow:checkout:p95", caller.environmentId);
    yield* claim("slow:search:p95", EnvironmentId.make("environment:elsewhere"));

    const listed = yield* callTool("list_findings", {});
    const repeated = yield* callTool("report_finding", slowCheckout);

    expect(listed.isError).toBe(false);
    expect(listed.structuredContent).toMatchObject({
      findings: [
        { fingerprint: "slow:search:p95", progress: { kind: "unknown" } },
        {
          fingerprint: "slow:checkout:p95",
          progress: { kind: "ready_to_merge", pr: readyPullRequest },
        },
      ],
    });
    expect(repeated.structuredContent).toMatchObject({
      created: false,
      finding: { progress: { kind: "ready_to_merge", pr: readyPullRequest } },
    });
  }).pipe(
    Effect.provide(
      layerTools(layerWatcherThread([run(1, MessageId.make("message:user"))], shells)),
    ),
  );
});
