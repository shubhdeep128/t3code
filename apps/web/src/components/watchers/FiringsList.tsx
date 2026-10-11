import type { EnvironmentId, ScheduledTaskFiringView } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { FiringStatusBadge } from "./findingPresentation";

export interface WatcherFiringRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly firing: ScheduledTaskFiringView;
}

function firingNote(firing: ScheduledTaskFiringView): string | null {
  if (firing.skipped !== null) {
    return firing.skippedCount > 1
      ? `Skipped ${firing.skippedCount} times, the previous run was still going`
      : "Skipped, the previous run was still going";
  }
  if (firing.error !== null) return firing.error;
  return firing.lastMessage;
}

/** Every firing across environments, newest first, with the outcome of the run it started. */
export function FiringsList({
  firings,
  taskTitles,
}: {
  firings: ReadonlyArray<WatcherFiringRow>;
  taskTitles: ReadonlyMap<string, string>;
}) {
  if (firings.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No runs yet</EmptyTitle>
          <EmptyDescription>
            Each time a watcher fires, or is skipped because its last run is still going, it shows
            here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const sorted = firings.toSorted(
    (a, b) => Date.parse(b.firing.firedAt) - Date.parse(a.firing.firedAt),
  );
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {sorted.map(({ environmentId, environmentLabel, firing }) => {
        const note = firingNote(firing);
        return (
          <li key={`${environmentId}:${firing.fireKey}`} className="flex flex-col gap-1 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {taskTitles.get(`${environmentId}:${firing.taskId}`) ?? "Deleted watcher"}
              </span>
              <FiringStatusBadge status={firing.status} />
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTimeLabel(firing.firedAt)}
              </span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{environmentLabel}</span>
              {firing.trigger !== "scheduled" ? <span>· {firing.trigger}</span> : null}
              {firing.threadId !== null ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: firing.threadId }}
                  className="underline-offset-2 hover:underline"
                >
                  Open thread
                </Link>
              ) : null}
              {note !== null ? <span className="min-w-0 flex-1 truncate">· {note}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
