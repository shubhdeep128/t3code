import type { FindingProgress, FindingSeverity, ScheduledTaskFiringView } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { Badge } from "../ui/badge";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const FIRING_STATUS: Record<
  ScheduledTaskFiringView["status"],
  { label: string; variant: BadgeVariant }
> = {
  preparing: { label: "Starting", variant: "info" },
  queued: { label: "Queued", variant: "info" },
  starting: { label: "Starting", variant: "info" },
  running: { label: "Running", variant: "info" },
  waiting: { label: "Waiting", variant: "warning" },
  completed: { label: "Done", variant: "success" },
  interrupted: { label: "Interrupted", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "error" },
  rolled_back: { label: "Rolled back", variant: "error" },
  skipped: { label: "Skipped", variant: "warning" },
  unknown: { label: "Unknown", variant: "outline" },
};

export function FiringStatusBadge({ status }: { status: ScheduledTaskFiringView["status"] }) {
  const { label, variant } = FIRING_STATUS[status];
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

const SEVERITY: Record<FindingSeverity, { label: string; variant: BadgeVariant }> = {
  high: { label: "High", variant: "destructive" },
  medium: { label: "Medium", variant: "warning" },
  low: { label: "Low", variant: "secondary" },
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  const { label, variant } = SEVERITY[severity];
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

export function progressLabel(progress: FindingProgress): { label: string; variant: BadgeVariant } {
  switch (progress.kind) {
    case "new":
      return { label: "New", variant: "outline" };
    case "working":
      return progress.stalled
        ? { label: "Stalled", variant: "warning" }
        : { label: "Working", variant: "info" };
    case "needs_you":
      return progress.reason === "question"
        ? { label: "Asks you", variant: "warning" }
        : { label: "Failed", variant: "error" };
    case "in_review":
      return { label: "In review", variant: "info" };
    case "ready_to_merge":
      return { label: "Ready to merge", variant: "success" };
    case "merged":
      return { label: "Merged", variant: "success" };
    case "detached":
      return { label: "Worker gone", variant: "error" };
    case "unknown":
      return { label: "On another machine", variant: "outline" };
    case "backlog":
      return { label: "Backlog", variant: "secondary" };
    case "dismissed":
      return { label: "Dismissed", variant: "secondary" };
  }
}

export function ProgressBadge({ progress }: { progress: FindingProgress }) {
  const { label, variant } = progressLabel(progress);
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

export type FindingActionKey =
  | "fix"
  | "start_again"
  | "stop_work"
  | "merge"
  | "backlog"
  | "restore"
  | "dismiss"
  | "reopen";

/** Kinds with a worker that may still be running, so dismiss asks about it first. */
export const RUNNING_KINDS: ReadonlySet<FindingProgress["kind"]> = new Set([
  "working",
  "needs_you",
  "in_review",
  "ready_to_merge",
]);

/** Which actions a finding offers. Backlog only without a running worker, and every way in has a way out. */
export function findingActions(progress: FindingProgress): ReadonlySet<FindingActionKey> {
  switch (progress.kind) {
    case "new":
      return new Set(["fix", "backlog", "dismiss"]);
    case "detached":
      return new Set(["start_again", "backlog", "dismiss"]);
    case "unknown":
    case "merged":
      return new Set(["backlog", "dismiss"]);
    case "working":
    case "in_review":
      return new Set(["stop_work", "dismiss"]);
    case "needs_you":
      return progress.reason === "failed"
        ? new Set(["start_again", "stop_work", "dismiss"])
        : new Set(["stop_work", "dismiss"]);
    case "ready_to_merge":
      return new Set(["merge", "stop_work", "dismiss"]);
    case "backlog":
      return new Set(["restore", "fix", "dismiss"]);
    case "dismissed":
      return new Set(["reopen"]);
  }
}

/** The action a letter key triggers, among the ones the finding offers. */
export function actionForKey(
  key: string,
  actions: ReadonlySet<FindingActionKey>,
): FindingActionKey | null {
  const candidates: Record<string, FindingActionKey[]> = {
    f: ["fix", "start_again"],
    b: ["backlog", "restore"],
    d: ["dismiss", "reopen"],
    m: ["merge"],
  };
  return candidates[key]?.find((action) => actions.has(action)) ?? null;
}
