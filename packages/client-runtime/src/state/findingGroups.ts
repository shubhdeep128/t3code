import type { Finding, FindingProgress } from "@t3tools/contracts";

export type FindingGroupKey =
  | "needs_you"
  | "ready_to_merge"
  | "new"
  | "in_progress"
  | "merged"
  | "backlog"
  | "dismissed";

/** Group order on the page. The first five are Today, the last two the Backlog filter. */
export const FINDING_GROUPS: ReadonlyArray<{
  readonly key: FindingGroupKey;
  readonly label: string;
}> = [
  { key: "needs_you", label: "Needs you" },
  { key: "ready_to_merge", label: "Ready to merge" },
  { key: "new", label: "New" },
  { key: "in_progress", label: "In progress" },
  { key: "merged", label: "Merged" },
  { key: "backlog", label: "Backlog" },
  { key: "dismissed", label: "Dismissed" },
];

export const TODAY_GROUP_KEYS: ReadonlySet<FindingGroupKey> = new Set([
  "needs_you",
  "ready_to_merge",
  "new",
  "in_progress",
  "merged",
]);

// Detached work needs a decision (start again or backlog), so it sits with the
// questions. Unknown work runs on a machine this client cannot read, so it is
// presumed to be going.
const GROUP_OF_KIND: Record<FindingProgress["kind"], FindingGroupKey> = {
  needs_you: "needs_you",
  detached: "needs_you",
  ready_to_merge: "ready_to_merge",
  new: "new",
  working: "in_progress",
  in_review: "in_progress",
  unknown: "in_progress",
  merged: "merged",
  backlog: "backlog",
  dismissed: "dismissed",
};

const SEVERITY_RANK: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };

export interface GroupableFinding {
  readonly finding: Pick<Finding, "severity" | "lastSeenAt">;
  readonly progress: FindingProgress;
}

export interface FindingGroup<T> {
  readonly key: FindingGroupKey;
  readonly label: string;
  readonly items: ReadonlyArray<T>;
}

/**
 * Every group in page order, including empty ones, with items from every
 * environment merged and sorted by severity, then newest last seen first.
 */
export function groupFindings<T extends GroupableFinding>(
  items: ReadonlyArray<T>,
): ReadonlyArray<FindingGroup<T>> {
  const byGroup = new Map<FindingGroupKey, T[]>(FINDING_GROUPS.map((group) => [group.key, []]));
  for (const item of items) {
    byGroup.get(GROUP_OF_KIND[item.progress.kind])!.push(item);
  }
  return FINDING_GROUPS.map((group) => ({
    ...group,
    items: byGroup
      .get(group.key)!
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
          Date.parse(b.finding.lastSeenAt) - Date.parse(a.finding.lastSeenAt),
      ),
  }));
}
