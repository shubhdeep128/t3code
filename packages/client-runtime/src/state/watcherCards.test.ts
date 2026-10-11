import {
  EnvironmentId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskFiringView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { summarizeWatchers } from "./watcherCards.ts";

const mini = EnvironmentId.make("mini");
const mbp = EnvironmentId.make("mbp");
const perf = { id: ScheduledTaskId.make("perf"), title: "Perf watcher" } as ScheduledTask;
const qa = { id: ScheduledTaskId.make("qa"), title: "QA sweeper" } as ScheduledTask;
const sync = { id: ScheduledTaskId.make("sync"), title: "Upstream sync" } as ScheduledTask;

function firing(
  taskId: ScheduledTaskId,
  firedAt: string,
  status: ScheduledTaskFiringView["status"],
  skipped: ScheduledTaskFiringView["skipped"] = null,
): ScheduledTaskFiringView {
  return {
    fireKey: `${taskId}:${firedAt}`,
    taskId,
    trigger: "scheduled",
    firedAt,
    threadId: null,
    messageId: null,
    skipped,
    skippedCount: skipped === null ? 0 : 3,
    error: null,
    status,
    completedAt: null,
    lastMessage: null,
  };
}

const fromTask = (taskId: ScheduledTaskId, triage: "open" | "backlog" | "dismissed") => ({
  source: { type: "scheduled_task" as const, taskId, fireKey: "k" },
  triage,
});

describe("summarizeWatchers", () => {
  it("summarizes each task across environments, including one that never ran", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    const latestPerf = firing(perf.id, "2026-10-11T06:00:00Z", "skipped", "previous_run_active");
    const latestQa = firing(qa.id, "2026-10-11T02:00:00Z", "completed");

    expect(
      summarizeWatchers(
        {
          tasks: [
            { environmentId: mini, task: perf },
            { environmentId: mbp, task: qa },
            { environmentId: mini, task: sync },
          ],
          firings: [
            { environmentId: mini, firing: firing(perf.id, "2026-10-10T06:00:00Z", "completed") },
            { environmentId: mini, firing: latestPerf },
            { environmentId: mini, firing: firing(perf.id, "2026-10-03T06:00:00Z", "failed") },
            { environmentId: mbp, firing: latestQa },
            // Another environment's task with the same id does not count here.
            { environmentId: mbp, firing: firing(perf.id, "2026-10-11T07:00:00Z", "completed") },
          ],
          findings: [
            { environmentId: mini, finding: fromTask(perf.id, "open") },
            { environmentId: mini, finding: fromTask(perf.id, "open") },
            { environmentId: mini, finding: fromTask(perf.id, "backlog") },
            { environmentId: mbp, finding: fromTask(perf.id, "open") },
            {
              environmentId: mbp,
              finding: { source: { type: "thread", threadId: "t" as never }, triage: "open" },
            },
          ],
        },
        now,
      ),
    ).toEqual([
      {
        environmentId: mini,
        task: perf,
        lastFiring: latestPerf,
        openFindings: 2,
        firingsInWeek: 1,
      },
      { environmentId: mbp, task: qa, lastFiring: latestQa, openFindings: 0, firingsInWeek: 1 },
      { environmentId: mini, task: sync, lastFiring: null, openFindings: 0, firingsInWeek: 0 },
    ]);
  });
});
