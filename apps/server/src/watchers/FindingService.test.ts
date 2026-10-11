import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FindingId,
  ProjectId,
  FindingsListResult,
  ThreadId,
  type Finding,
  type OrchestrationV2ThreadShell,
  type PullRequestState,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as FindingService from "./FindingService.ts";

const T0 = Date.parse("2026-10-11T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const BENCH_FINDINGS = 2_000;
const BENCH_OPEN_AND_RECENT = 300;
const at = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(T0 + millis));

const encodeList = Schema.encodeEffect(Schema.fromJsonString(FindingsListResult));

const HERE = EnvironmentId.make("environment:here");
const ELSEWHERE = EnvironmentId.make("environment:elsewhere");
const PROJECT = ProjectId.make("project:app");
const OTHER_PROJECT = ProjectId.make("project:api");
const WATCHER = ThreadId.make("thread:watcher");
const WORKER = ThreadId.make("thread:worker");
const RIVAL = ThreadId.make("thread:rival");

/**
 * Thread shells standing in for the projection. The watcher's run has no
 * record, so its findings come from the thread, and reading it yields like a
 * database read, so concurrent reports interleave there.
 */
class FakeThreads {
  readonly shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [WATCHER, { ...liveThreadShell(WATCHER), projectId: PROJECT }],
  ]);

  workerWithPullRequest(state: PullRequestState) {
    this.shells.set(WORKER, {
      ...liveThreadShell(WORKER),
      projectId: PROJECT,
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          source: "agent",
          linkedAt: at(0),
          snapshot: {
            state,
            title: "Fix the crash",
            headBranch: "fix/crash",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: at(0),
          },
          stack: null,
        },
      ],
    });
  }

  layer() {
    let uuids = 0;
    return Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.sync(() => this.shells.get(threadId) ?? null),
        getThreadRecords: () => Effect.yieldNow.pipe(Effect.as({ runs: [] } as never)),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(HERE) }),
      // Numbered ids, so a test can name the finding a report files.
      Layer.effect(
        Crypto.Crypto,
        Effect.map(Crypto.Crypto, (crypto) => ({
          ...crypto,
          randomUUIDv4: Effect.sync(() => `${++uuids}`),
        })),
      ).pipe(Layer.provide(NodeCrypto.layer)),
    );
  }
}

const withFindings = <A, E>(
  body: (
    findings: FindingService.FindingService["Service"],
    threads: FakeThreads,
  ) => Effect.Effect<A, E>,
) => {
  const threads = new FakeThreads();
  return TestClock.setTime(T0).pipe(
    Effect.andThen(FindingService.FindingService),
    Effect.flatMap((findings) => body(findings, threads)),
    Effect.provide(
      FindingService.layer.pipe(
        Layer.provide(threads.layer()),
        Layer.provide(SqlitePersistence.layerMemory),
      ),
    ),
  );
};

const crash = {
  threadId: WATCHER,
  fingerprint: "crash:checkout:NullPointer",
  title: "Checkout crashes on an empty cart",
  detail: "Stack trace from the 06:00 run.",
  severity: "high" as const,
};

const filed = (overrides: Partial<Finding> = {}): Finding => ({
  findingId: FindingId.make("finding:1"),
  projectId: PROJECT,
  fingerprint: "crash:checkout:NullPointer",
  title: "Checkout crashes on an empty cart",
  detail: "Stack trace from the 06:00 run.",
  severity: "high",
  source: { type: "thread", threadId: WATCHER },
  triage: "open",
  workThread: null,
  workAttempt: 0,
  workMergedAt: null,
  firstSeenAt: at(0),
  lastSeenAt: at(0),
  seenCount: 1,
  ...overrides,
});

it.effect("a repeated fingerprint returns the finding already filed and counts the sighting", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      expect(yield* findings.report(crash)).toEqual({ finding: filed(), created: true });
      yield* findings.update({
        findingId: FindingId.make("finding:1"),
        claim: { workThread: { environmentId: HERE, threadId: WORKER }, expectedWorkAttempt: 0 },
      });

      yield* TestClock.adjust(60_000);
      const repeat = yield* findings.report({ ...crash, detail: "Seen again." });

      expect(repeat).toEqual({
        finding: filed({
          workThread: { environmentId: HERE, threadId: WORKER },
          workAttempt: 1,
          lastSeenAt: at(60_000),
          seenCount: 2,
        }),
        created: false,
      });
      expect((yield* findings.list({})).findings).toHaveLength(1);
    }),
  ),
);

it.effect("a dismissed fingerprint stays dismissed when it is reported again", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      yield* findings.report(crash);
      yield* findings.update({ findingId: FindingId.make("finding:1"), triage: "dismissed" });

      const repeat = yield* findings.report(crash);

      expect(repeat).toEqual({
        finding: filed({ triage: "dismissed", seenCount: 2 }),
        created: false,
      });
      expect((yield* findings.list({})).findings.map((finding) => finding.findingId)).toEqual([
        "finding:1",
      ]);
    }),
  ),
);

it.effect("a fingerprint whose local work merged opens a new finding that names the old one", () =>
  withFindings((findings, threads) =>
    Effect.gen(function* () {
      yield* findings.report(crash);
      yield* findings.update({
        findingId: FindingId.make("finding:1"),
        claim: { workThread: { environmentId: HERE, threadId: WORKER }, expectedWorkAttempt: 0 },
      });
      threads.workerWithPullRequest("open");
      expect((yield* findings.report(crash)).created).toBe(false);

      threads.workerWithPullRequest("merged");
      yield* TestClock.adjust(60_000);
      const reopened = yield* findings.report(crash);

      expect(reopened).toEqual({
        finding: filed({
          findingId: FindingId.make("finding:2"),
          detail:
            "Stack trace from the 06:00 run.\n\nPrevious finding, whose fix merged: finding:1",
          firstSeenAt: at(60_000),
          lastSeenAt: at(60_000),
        }),
        created: true,
      });
      expect((yield* findings.report(crash)).finding.findingId).toBe("finding:2");
    }),
  ),
);

it.effect("work on another machine counts as merged once a client records workMergedAt", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      yield* findings.report(crash);
      yield* findings.update({
        findingId: FindingId.make("finding:1"),
        claim: {
          workThread: { environmentId: ELSEWHERE, threadId: WORKER },
          expectedWorkAttempt: 0,
        },
      });
      expect((yield* findings.report(crash)).created).toBe(false);

      expect(
        (yield* findings
          .update({ findingId: FindingId.make("finding:1"), workMergedAt: "" })
          .pipe(Effect.flip)).message,
      ).toBe("workMergedAt is not a date and time.");
      yield* findings.update({ findingId: FindingId.make("finding:1"), workMergedAt: at(5_000) });
      yield* findings.update({ findingId: FindingId.make("finding:1"), workMergedAt: at(9_000) });
      const reopened = yield* findings.report(crash);

      expect(reopened.created).toBe(true);
      expect(reopened.finding.findingId).toBe("finding:2");
      expect((yield* findings.list({ triage: "open" })).findings).toEqual([
        reopened.finding,
        filed({
          workThread: { environmentId: ELSEWHERE, threadId: WORKER },
          workAttempt: 1,
          workMergedAt: at(5_000),
          seenCount: 2,
        }),
      ]);
    }),
  ),
);

it.effect("two watchers reporting the same new problem at once file it once", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      const results = yield* Effect.all([findings.report(crash), findings.report(crash)], {
        concurrency: "unbounded",
      });

      expect(results.map(({ created }) => created).toSorted()).toEqual([false, true]);
      expect(yield* findings.list({})).toEqual({ findings: [filed({ seenCount: 2 })] });
    }),
  ),
);

it.effect("two claims on the same attempt leave one winner and one FindingClaimConflict", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      yield* findings.report(crash);
      const claim = (threadId: ThreadId) =>
        findings
          .update({
            findingId: FindingId.make("finding:1"),
            claim: { workThread: { environmentId: HERE, threadId }, expectedWorkAttempt: 0 },
          })
          .pipe(Effect.result);

      const results = yield* Effect.all([claim(WORKER), claim(RIVAL)], {
        concurrency: "unbounded",
      });

      const won = results.flatMap((result) =>
        result._tag === "Success" ? [result.success.finding.workThread?.threadId] : [],
      );
      const lost = results.flatMap((result) => (result._tag === "Failure" ? [result.failure] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({
        _tag: "FindingClaimConflict",
        findingId: "finding:1",
        expectedWorkAttempt: 0,
        workAttempt: 1,
      });
      expect((yield* findings.list({})).findings[0]).toMatchObject({
        workThread: { environmentId: HERE, threadId: won[0] },
        workAttempt: 1,
      });
    }),
  ),
);

it.effect("backlog, restore, dismiss, reopen and detach each have a way back", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      yield* findings.report(crash);
      const findingId = FindingId.make("finding:1");
      const triage = (next: "open" | "backlog" | "dismissed") =>
        findings
          .update({ findingId, triage: next })
          .pipe(Effect.map(({ finding }) => finding.triage));

      expect([
        yield* triage("backlog"),
        yield* triage("open"),
        yield* triage("dismissed"),
        yield* triage("open"),
      ]).toEqual(["backlog", "open", "dismissed", "open"]);

      yield* findings.update({
        findingId,
        claim: { workThread: { environmentId: HERE, threadId: WORKER }, expectedWorkAttempt: 0 },
      });
      const detached = yield* findings.update({
        findingId,
        claim: { workThread: null, expectedWorkAttempt: 1 },
      });
      expect(detached.finding).toEqual(filed({ workAttempt: 2 }));

      const missing = yield* findings
        .update({ findingId: FindingId.make("finding:none"), triage: "open" })
        .pipe(Effect.flip);
      expect(missing.message).toBe("The finding was not found.");
    }),
  ),
);

it.effect("list filters by project, triage, time and text", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      yield* findings.report(crash);
      yield* TestClock.adjust(DAY);
      yield* findings.report({
        ...crash,
        projectId: OTHER_PROJECT,
        fingerprint: "slow:api:orders",
        title: "Orders endpoint is slow",
        severity: "medium",
      });
      yield* findings.update({ findingId: FindingId.make("finding:2"), triage: "backlog" });
      const ids = (input: Parameters<typeof findings.list>[0]) =>
        findings
          .list(input)
          .pipe(Effect.map(({ findings }) => findings.map((finding) => finding.findingId)));

      expect(yield* ids({})).toEqual(["finding:2", "finding:1"]);
      expect(yield* ids({ projectId: PROJECT })).toEqual(["finding:1"]);
      expect(yield* ids({ triage: "backlog" })).toEqual(["finding:2"]);
      expect(yield* ids({ since: "2026-10-12T11:00:00+02:00" })).toEqual(["finding:2"]);
      expect(yield* ids({ query: "ORDERS" })).toEqual(["finding:2"]);
      expect(yield* ids({ query: "nullpointer" })).toEqual(["finding:1"]);
      expect((yield* findings.list({ since: "last week" }).pipe(Effect.flip)).message).toBe(
        "since is not a date and time.",
      );
    }),
  ),
);

it.effect("subscribe starts with open findings and the last 14 days, then follows changes", () =>
  withFindings((findings) =>
    Effect.gen(function* () {
      const report = (fingerprint: string) => findings.report({ ...crash, fingerprint });
      yield* report("old-open");
      yield* report("old-dismissed");
      yield* findings.update({ findingId: FindingId.make("finding:2"), triage: "dismissed" });
      yield* report("old-backlog");
      yield* findings.update({ findingId: FindingId.make("finding:3"), triage: "backlog" });
      yield* TestClock.adjust(17 * DAY);
      yield* report("recent-backlog");
      yield* findings.update({ findingId: FindingId.make("finding:4"), triage: "backlog" });
      yield* TestClock.adjust(3 * DAY);

      const firstListed = yield* Deferred.make<void>();
      const lists = yield* findings.subscribeList().pipe(
        Stream.map(({ findings }) => findings.map((finding) => finding.fingerprint)),
        Stream.tap(() => Deferred.succeed(firstListed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstListed);
      yield* report("new");

      expect(yield* Fiber.join(lists)).toEqual([
        ["recent-backlog", "old-open"],
        ["new", "recent-backlog", "old-open"],
      ]);
    }),
  ),
);

it.effect("findings outlive a restart of the service", () => {
  const threads = new FakeThreads();
  const started = <A, E>(
    body: (findings: FindingService.FindingService["Service"]) => Effect.Effect<A, E>,
  ) =>
    FindingService.FindingService.pipe(
      Effect.flatMap(body),
      Effect.provide(FindingService.layer.pipe(Layer.provide(threads.layer()))),
    );
  return TestClock.setTime(T0).pipe(
    Effect.andThen(started((findings) => findings.report(crash))),
    Effect.andThen(started((findings) => findings.list({}))),
    Effect.map((listed) => expect(listed).toEqual({ findings: [filed()] })),
    Effect.provide(SqlitePersistence.layerMemory),
  );
});

it.effect.skipIf(process.env.T3_BENCH !== "1")(
  "bench: list and the first subscribe list with 2,000 findings",
  () =>
    withFindings((findings) =>
      Effect.gen(function* () {
        for (let index = 0; index < BENCH_FINDINGS; index++) {
          const { finding } = yield* findings.report({
            ...crash,
            fingerprint: `bench:${index}`,
            detail: "A stack trace and the steps that led to it. ".repeat(4),
          });
          if (index < BENCH_FINDINGS - BENCH_OPEN_AND_RECENT) {
            yield* findings.update({ findingId: finding.findingId, triage: "backlog" });
          }
          if (index === BENCH_FINDINGS - BENCH_OPEN_AND_RECENT - 1) {
            yield* TestClock.adjust(30 * DAY);
          }
        }
        yield* findings.list({});
        const times: Array<number> = [];
        for (let run = 0; run < 5; run++) {
          const started = performance.now();
          yield* findings.list({});
          times.push(performance.now() - started);
        }
        const median = times.toSorted((left, right) => left - right)[2] ?? Infinity;
        const first = yield* findings.subscribeList().pipe(Stream.runHead);
        const bytes = Buffer.byteLength(yield* encodeList(Option.getOrThrow(first)));
        yield* Effect.sync(() =>
          process.stdout.write(
            `findings.list median ${median.toFixed(1)} ms; first subscribe list ${bytes} bytes\n`,
          ),
        );
        expect(median).toBeLessThan(30);
        expect(bytes).toBeLessThan(300 * 1024);
      }),
    ),
);
