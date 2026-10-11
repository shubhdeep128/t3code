import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type Finding,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveFindingProgress,
  type FindingWork,
  type FindingWorkShell,
} from "./findingProgress.ts";

const NOW = DateTime.makeUnsafe("2026-10-11T12:00:00.000Z");

const LOCAL_WORK = {
  environmentId: EnvironmentId.make("environment:here"),
  threadId: ThreadId.make("thread:worker"),
};

type FindingInput = Pick<Finding, "triage" | "workThread" | "workMergedAt">;

const claimed: FindingInput = { triage: "open", workThread: LOCAL_WORK, workMergedAt: null };
const unclaimed: FindingInput = { triage: "open", workThread: null, workMergedAt: null };

const worker = (overrides: Partial<FindingWorkShell> = {}): FindingWork => ({
  kind: "shell",
  shell: {
    activeRunId: RunId.make("run:2"),
    archivedAt: null,
    branch: "fix/crash",
    deletedAt: null,
    pendingBackgroundTasks: [],
    pendingRuntimeRequest: null,
    pullRequests: [],
    status: "running",
    updatedAt: DateTime.makeUnsafe("2026-10-11T11:55:00.000Z"),
    ...overrides,
  },
});

const settled = (overrides: Partial<FindingWorkShell> = {}) =>
  worker({ activeRunId: null, status: "completed", ...overrides });

const pullRequest = (
  number: number,
  snapshot: Partial<ThreadPullRequestSnapshot> = {},
  linkedAt = "2026-10-11T10:00:00.000Z",
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  source: "agent",
  linkedAt,
  snapshot: {
    state: "open",
    title: "Fix the checkout crash",
    headBranch: "fix/crash",
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-10-11T11:00:00.000Z",
    reviewDecision: "approved",
    checksState: "passing",
    mergeability: "mergeable",
    ...snapshot,
  },
  stack: null,
});

describe("deriveFindingProgress", () => {
  it("new: open with no work thread", () => {
    expect(deriveFindingProgress(unclaimed, { kind: "unreachable" }, NOW)).toEqual({
      kind: "new",
    });
  });

  it("backlog and dismissed: the triage decision wins over a running worker", () => {
    expect(deriveFindingProgress({ ...claimed, triage: "backlog" }, worker(), NOW)).toEqual({
      kind: "backlog",
    });
    expect(deriveFindingProgress({ ...unclaimed, triage: "dismissed" }, worker(), NOW)).toEqual({
      kind: "dismissed",
    });
  });

  it("unknown: the work thread is in an environment the reader cannot read", () => {
    expect(deriveFindingProgress(claimed, { kind: "unreachable" }, NOW)).toEqual({
      kind: "unknown",
    });
  });

  it("merged: workMergedAt alone marks work on another machine as merged", () => {
    expect(
      deriveFindingProgress(
        { ...claimed, workMergedAt: "2026-10-11T08:00:00.000Z" },
        { kind: "unreachable" },
        NOW,
      ),
    ).toEqual({ kind: "merged", pr: null });
  });

  it("merged: the worker's pull request merged, even after its thread was archived", () => {
    const merged = pullRequest(7, { state: "merged" });
    expect(deriveFindingProgress(claimed, settled({ pullRequests: [merged] }), NOW)).toEqual({
      kind: "merged",
      pr: merged,
    });
    expect(
      deriveFindingProgress(
        claimed,
        settled({
          pullRequests: [merged],
          archivedAt: DateTime.makeUnsafe("2026-10-11T11:00:00.000Z"),
        }),
        NOW,
      ),
    ).toEqual({ kind: "merged", pr: merged });
  });

  it("merged: a dismissed finding whose fix merged still reads as merged", () => {
    const merged = pullRequest(7, { state: "merged" });
    expect(
      deriveFindingProgress(
        { ...claimed, triage: "dismissed" },
        settled({ pullRequests: [merged] }),
        NOW,
      ),
    ).toEqual({ kind: "merged", pr: merged });
  });

  it("detached: the work thread is missing, archived or deleted", () => {
    expect(deriveFindingProgress(claimed, { kind: "missing" }, NOW)).toEqual({
      kind: "detached",
    });
    expect(
      deriveFindingProgress(
        claimed,
        worker({ archivedAt: DateTime.makeUnsafe("2026-10-11T11:00:00.000Z") }),
        NOW,
      ),
    ).toEqual({ kind: "detached" });
    expect(
      deriveFindingProgress(
        claimed,
        worker({
          pullRequests: [pullRequest(7)],
          deletedAt: DateTime.makeUnsafe("2026-10-11T11:00:00.000Z"),
        }),
        NOW,
      ),
    ).toEqual({ kind: "detached" });
  });

  it("needs_you question: the worker waits on the user, even with an open pull request", () => {
    expect(
      deriveFindingProgress(
        claimed,
        worker({
          status: "waiting",
          pullRequests: [pullRequest(7, { checksState: "pending" })],
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request:1"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe("2026-10-11T11:58:00.000Z"),
          },
        }),
        NOW,
      ),
    ).toEqual({ kind: "needs_you", reason: "question" });
  });

  it("an auth refresh is not a question for the user", () => {
    expect(
      deriveFindingProgress(
        claimed,
        worker({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request:1"),
            kind: "auth_refresh",
            createdAt: DateTime.makeUnsafe("2026-10-11T11:58:00.000Z"),
          },
        }),
        NOW,
      ),
    ).toEqual({ kind: "working", stalled: false });
  });

  it("needs_you failed: the worker's last run failed with no pull request open", () => {
    expect(deriveFindingProgress(claimed, settled({ status: "failed" }), NOW)).toEqual({
      kind: "needs_you",
      reason: "failed",
    });
  });

  it("in_review: an open pull request that is not approved yet", () => {
    const awaitingReview = pullRequest(7, { reviewDecision: "review-required" });
    expect(
      deriveFindingProgress(claimed, settled({ pullRequests: [awaitingReview] }), NOW),
    ).toEqual({ kind: "in_review", pr: awaitingReview });
  });

  it("in_review: open but draft, red, pending, conflicting, changes requested or never synced", () => {
    const notReady = [
      pullRequest(7, { isDraft: true }),
      pullRequest(7, { checksState: "failing" }),
      pullRequest(7, { checksState: "pending" }),
      pullRequest(7, { mergeability: "conflicting" }),
      pullRequest(7, { reviewDecision: "changes-requested" }),
      { ...pullRequest(7), snapshot: null },
    ];
    expect(
      notReady.map(
        (pr) => deriveFindingProgress(claimed, settled({ pullRequests: [pr] }), NOW).kind,
      ),
    ).toEqual(["in_review", "in_review", "in_review", "in_review", "in_review", "in_review"]);
  });

  it("ready_to_merge: a synced pull request whose head commit has no checks at all", () => {
    const noChecks = pullRequest(7, { checksState: null });
    expect(deriveFindingProgress(claimed, settled({ pullRequests: [noChecks] }), NOW)).toEqual({
      kind: "ready_to_merge",
      pr: noChecks,
    });
  });

  it("in_review: a snapshot whose host never reported checks", () => {
    const checksNotReported: ThreadPullRequestLink = {
      host: "github.com",
      repository: "acme/app",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      source: "agent",
      linkedAt: "2026-10-11T10:00:00.000Z",
      snapshot: {
        state: "open",
        title: "Fix the checkout crash",
        headBranch: "fix/crash",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-10-11T11:00:00.000Z",
        reviewDecision: "approved",
        mergeability: "mergeable",
      },
      stack: null,
    };
    expect(
      deriveFindingProgress(claimed, settled({ pullRequests: [checksNotReported] }), NOW),
    ).toEqual({ kind: "in_review", pr: checksNotReported });
  });

  it("ready_to_merge: open, green and mergeable, approved or needing no review", () => {
    const approved = pullRequest(7);
    const noReviewRequired = pullRequest(7, { reviewDecision: null });
    expect(deriveFindingProgress(claimed, settled({ pullRequests: [approved] }), NOW)).toEqual({
      kind: "ready_to_merge",
      pr: approved,
    });
    expect(
      deriveFindingProgress(claimed, settled({ pullRequests: [noReviewRequired] }), NOW),
    ).toEqual({ kind: "ready_to_merge", pr: noReviewRequired });
  });

  it("working: a run with activity 29 minutes ago is not stalled", () => {
    expect(
      deriveFindingProgress(
        claimed,
        worker({ updatedAt: DateTime.makeUnsafe("2026-10-11T11:31:00.000Z") }),
        NOW,
      ),
    ).toEqual({ kind: "working", stalled: false });
  });

  it("working: a run with no activity for 31 minutes is stalled", () => {
    expect(
      deriveFindingProgress(
        claimed,
        worker({ updatedAt: DateTime.makeUnsafe("2026-10-11T11:29:00.000Z") }),
        NOW,
      ),
    ).toEqual({ kind: "working", stalled: true });
  });

  it("working: an idle worker with no pull request is stalled at once", () => {
    expect(deriveFindingProgress(claimed, settled(), NOW)).toEqual({
      kind: "working",
      stalled: true,
    });
  });

  it("working: a closed pull request that never merged leaves the idle worker stalled", () => {
    expect(
      deriveFindingProgress(
        claimed,
        settled({ pullRequests: [pullRequest(7, { state: "closed" })] }),
        NOW,
      ),
    ).toEqual({ kind: "working", stalled: true });
  });

  it("working: a settled worker waiting on its subagent is not stalled", () => {
    expect(
      deriveFindingProgress(
        claimed,
        settled({ pendingBackgroundTasks: [{ taskId: "task:1", kind: "subagent" }] }),
        NOW,
      ),
    ).toEqual({ kind: "working", stalled: false });
  });

  it("the worker's pull request is the one for its branch, not a merged layer below it", () => {
    const base = pullRequest(
      6,
      { state: "merged", headBranch: "fix/base" },
      "2026-10-11T11:00:00.000Z",
    );
    const own = pullRequest(7, { reviewDecision: "review-required" });
    expect(deriveFindingProgress(claimed, settled({ pullRequests: [base, own] }), NOW)).toEqual({
      kind: "in_review",
      pr: own,
    });
  });

  it("without a pull request for its branch, the worker's is the one it linked last", () => {
    const first = pullRequest(6, { headBranch: "fix/one" }, "2026-10-11T10:00:00.000Z");
    const last = pullRequest(
      7,
      { state: "merged", headBranch: "fix/two" },
      "2026-10-11T11:00:00.000Z",
    );
    const stackLayer = {
      ...pullRequest(8, { headBranch: "fix/three", state: "closed" }, "2026-10-11T11:30:00.000Z"),
      source: "stack" as const,
    };
    expect(
      deriveFindingProgress(
        claimed,
        settled({ branch: null, pullRequests: [last, stackLayer, first] }),
        NOW,
      ),
    ).toEqual({ kind: "merged", pr: last });
  });

  it.skipIf(process.env.T3_BENCH !== "1")("bench: 10,000 derivations", () => {
    const works = [
      worker(),
      settled({ pullRequests: [pullRequest(7)] }),
      { kind: "missing" as const },
    ];
    const times: Array<number> = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      for (let index = 0; index < 10_000; index++) {
        deriveFindingProgress(claimed, works[index % works.length]!, NOW);
      }
      times.push(performance.now() - started);
    }
    const median = times.toSorted((left, right) => left - right)[2]!;
    process.stdout.write(`10,000 derivations median ${median.toFixed(1)} ms\n`);
    expect(median).toBeLessThan(20);
  });
});
