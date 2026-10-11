import {
  CommandId,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type Finding,
  type FindingId,
  type WorkThreadRef,
} from "@t3tools/contracts";

export interface FindingWorkIds {
  readonly attempt: number;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
}

/** Ids for one attempt at a finding, so a retried launch lands on the same thread. */
export function findingWorkIds(findingId: FindingId, attempt: number): FindingWorkIds {
  const base = `finding-work:${findingId}:${attempt}`;
  return {
    attempt,
    threadId: ThreadId.make(base),
    messageId: MessageId.make(`${base}:brief`),
    commandId: CommandId.make(`${base}:start`),
  };
}

export function findingWorkBranch(title: string, attempt: number): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "finding";
  return attempt > 1 ? `finding/${slug}-${attempt}` : `finding/${slug}`;
}

const BRIEF_PREAMBLE = [
  "You are fixing a problem a watcher found. Work in this worktree only.",
  "Read the repository's AGENTS.md first and follow it.",
  "When the fix is ready, open a pull request, link it to this thread with `link_pull_request`, and watch it with `watch_pull_request`. Address review comments and failing checks until it is ready to merge.",
  "Never merge the pull request. A person merges it.",
  "If you cannot reproduce the problem or the fix needs a decision, ask instead of guessing.",
].join("\n");

export function findingWorkBrief(
  finding: Pick<Finding, "findingId" | "title" | "detail" | "severity">,
): string {
  return `${BRIEF_PREAMBLE}\n\n## Finding ${finding.findingId} (${finding.severity})\n\n# ${finding.title}\n\n${finding.detail}`;
}

export type StartFindingWorkMode =
  /** Claim the next attempt on the finding's server, then launch. */
  | { readonly kind: "claim"; readonly expectedWorkAttempt: number }
  /** The claim already happened and the launch failed: launch the same thread again. */
  | { readonly kind: "retry"; readonly attempt: number };

export type ClaimOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly conflict: boolean; readonly error: unknown };

export type LaunchOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export type StartFindingWorkResult =
  | { readonly kind: "launched"; readonly ids: FindingWorkIds }
  | { readonly kind: "claimed_elsewhere" }
  | { readonly kind: "claim_failed"; readonly error: unknown }
  | { readonly kind: "launch_failed"; readonly ids: FindingWorkIds; readonly error: unknown };

/**
 * Claim first, launch second. The worker's ids derive from the attempt, so the
 * claim records the thread before it exists and a retry reuses it without a
 * second claim. A lost claim never launches.
 */
export async function startFindingWork(
  input: {
    readonly findingId: FindingId;
    readonly workEnvironmentId: EnvironmentId;
    readonly mode: StartFindingWorkMode;
  },
  io: {
    readonly claim: (claim: {
      readonly workThread: WorkThreadRef;
      readonly expectedWorkAttempt: number;
    }) => Promise<ClaimOutcome>;
    readonly launch: (ids: FindingWorkIds) => Promise<LaunchOutcome>;
  },
): Promise<StartFindingWorkResult> {
  const attempt =
    input.mode.kind === "claim" ? input.mode.expectedWorkAttempt + 1 : input.mode.attempt;
  const ids = findingWorkIds(input.findingId, attempt);
  if (input.mode.kind === "claim") {
    const claimed = await io.claim({
      workThread: { environmentId: input.workEnvironmentId, threadId: ids.threadId },
      expectedWorkAttempt: input.mode.expectedWorkAttempt,
    });
    if (!claimed.ok) {
      return claimed.conflict
        ? { kind: "claimed_elsewhere" }
        : { kind: "claim_failed", error: claimed.error };
    }
  }
  const launched = await io.launch(ids);
  return launched.ok
    ? { kind: "launched", ids }
    : { kind: "launch_failed", ids, error: launched.error };
}
