import type {
  Finding,
  FindingProgress,
  OrchestrationV2ThreadShell,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";
import { visibleThreadPullRequests } from "./threadPullRequests.ts";

const STALLED_AFTER_MS = 30 * 60 * 1000;

export type FindingWorkShell = Pick<
  OrchestrationV2ThreadShell,
  | "activeRunId"
  | "archivedAt"
  | "branch"
  | "deletedAt"
  | "pendingBackgroundTasks"
  | "pendingRuntimeRequest"
  | "pullRequests"
  | "status"
  | "updatedAt"
>;

/**
 * `missing` means the caller read the work thread's environment and found no
 * such thread. `unreachable` means it cannot read that environment.
 */
export type FindingWork =
  | { readonly kind: "shell"; readonly shell: FindingWorkShell }
  | { readonly kind: "missing" }
  | { readonly kind: "unreachable" };

function workerPullRequest(shell: FindingWorkShell): ThreadPullRequestLink | null {
  const links = visibleThreadPullRequests(shell.pullRequests ?? []);
  const forBranch = links.find(
    (link) => shell.branch !== null && link.snapshot?.headBranch === shell.branch,
  );
  if (forBranch !== undefined) return forBranch;
  const linkedByWorker = links.filter((link) => link.source !== "stack");
  return linkedByWorker.reduce<ThreadPullRequestLink | null>(
    (newest, link) =>
      newest === null || Date.parse(link.linkedAt) > Date.parse(newest.linkedAt) ? link : newest,
    null,
  );
}

// A synced snapshot stores `checksState: null` when the head commit reports no
// checks at all. The field is absent when the host's read never reported checks.
const readyToMerge = (snapshot: ThreadPullRequestSnapshot | null) =>
  snapshot !== null &&
  !snapshot.isDraft &&
  snapshot.mergeability === "mergeable" &&
  (snapshot.checksState === "passing" || snapshot.checksState === null) &&
  (snapshot.reviewDecision == null || snapshot.reviewDecision === "approved");

/**
 * `work` is what the caller found for `finding.workThread`, and is not read
 * when the finding has none. Merged comes before triage, so a dismissed
 * finding whose fix merged still counts as fixed when the problem returns.
 */
export function deriveFindingProgress(
  finding: Pick<Finding, "triage" | "workThread" | "workMergedAt">,
  work: FindingWork,
  now: DateTime.Utc,
): FindingProgress {
  const shell = finding.workThread !== null && work.kind === "shell" ? work.shell : null;
  const pr = shell === null ? null : workerPullRequest(shell);
  if (finding.workMergedAt !== null || pr?.snapshot?.state === "merged") {
    return { kind: "merged", pr };
  }
  if (finding.triage !== "open") return { kind: finding.triage };
  if (finding.workThread === null) return { kind: "new" };
  if (work.kind === "unreachable") return { kind: "unknown" };
  if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) {
    return { kind: "detached" };
  }
  // Clients show no prompt for an auth refresh, so the user has nothing to answer.
  if (shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.kind !== "auth_refresh") {
    return { kind: "needs_you", reason: "question" };
  }
  if (pr !== null && pr.snapshot?.state !== "closed") {
    return readyToMerge(pr.snapshot) ? { kind: "ready_to_merge", pr } : { kind: "in_review", pr };
  }
  if (shell.status === "failed") return { kind: "needs_you", reason: "failed" };
  const running =
    shell.activeRunId !== null || backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []);
  return {
    kind: "working",
    stalled:
      !running ||
      DateTime.toEpochMillis(now) - DateTime.toEpochMillis(shell.updatedAt) >= STALLED_AFTER_MS,
  };
}
