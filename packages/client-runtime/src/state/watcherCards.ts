import type {
  EnvironmentId,
  Finding,
  ScheduledTask,
  ScheduledTaskFiringView,
} from "@t3tools/contracts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WatcherSummary {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  /** The newest firing, skipped ones included, or null when the watcher never ran. */
  readonly lastFiring: ScheduledTaskFiringView | null;
  /** Open findings this watcher filed. */
  readonly openFindings: number;
  /** Firings that dispatched in the last seven days. */
  readonly firingsInWeek: number;
}

export interface WatcherSummaryInput {
  readonly tasks: ReadonlyArray<{ environmentId: EnvironmentId; task: ScheduledTask }>;
  readonly firings: ReadonlyArray<{
    environmentId: EnvironmentId;
    firing: Pick<ScheduledTaskFiringView, "taskId" | "firedAt" | "skipped"> &
      Partial<ScheduledTaskFiringView>;
  }>;
  readonly findings: ReadonlyArray<{
    environmentId: EnvironmentId;
    finding: Pick<Finding, "source" | "triage">;
  }>;
}

const taskKey = (environmentId: EnvironmentId, taskId: string) => `${environmentId}:${taskId}`;

/** One card per scheduled task across environments, in the order the tasks were given. */
export function summarizeWatchers(
  input: WatcherSummaryInput,
  nowMs: number,
): ReadonlyArray<WatcherSummary> {
  const latest = new Map<string, ScheduledTaskFiringView>();
  const inWeek = new Map<string, number>();
  for (const { environmentId, firing } of input.firings) {
    const key = taskKey(environmentId, firing.taskId);
    const current = latest.get(key);
    if (current === undefined || Date.parse(firing.firedAt) > Date.parse(current.firedAt)) {
      latest.set(key, firing as ScheduledTaskFiringView);
    }
    if (firing.skipped === null && Date.parse(firing.firedAt) >= nowMs - WEEK_MS) {
      inWeek.set(key, (inWeek.get(key) ?? 0) + 1);
    }
  }
  const open = new Map<string, number>();
  for (const { environmentId, finding } of input.findings) {
    if (finding.triage !== "open" || finding.source.type !== "scheduled_task") continue;
    const key = taskKey(environmentId, finding.source.taskId);
    open.set(key, (open.get(key) ?? 0) + 1);
  }
  return input.tasks.map(({ environmentId, task }) => {
    const key = taskKey(environmentId, task.id);
    return {
      environmentId,
      task,
      lastFiring: latest.get(key) ?? null,
      openFindings: open.get(key) ?? 0,
      firingsInWeek: inWeek.get(key) ?? 0,
    };
  });
}
