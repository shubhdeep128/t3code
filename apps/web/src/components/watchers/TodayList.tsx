import { memo, useEffect, useRef } from "react";

import type { FindingGroup } from "@t3tools/client-runtime/state/finding-groups";

import { cn } from "../../lib/utils";
import type { WatcherFindingRow } from "../../state/watchers";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ProgressBadge, SeverityBadge } from "./findingPresentation";

export function sourceLabel(
  row: Pick<WatcherFindingRow, "environmentId" | "finding">,
  taskTitles: ReadonlyMap<string, string>,
): string {
  const source = row.finding.source;
  if (source.type === "thread") return "Filed from a thread";
  return taskTitles.get(`${row.environmentId}:${source.taskId}`) ?? "Deleted watcher";
}

const FindingRow = memo(function FindingRow({
  row,
  highlighted,
  open,
  source,
  onHighlight,
  onOpen,
}: {
  row: WatcherFindingRow;
  highlighted: boolean;
  open: boolean;
  source: string;
  onHighlight: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-finding-key={row.key}
        aria-current={open ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-1 rounded-md border-l-2 border-transparent px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          highlighted && "bg-accent",
          open && "border-primary",
        )}
        onMouseEnter={() => onHighlight(row.key)}
        onFocus={() => onHighlight(row.key)}
        onClick={() => onOpen(row.key)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {row.finding.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTimeLabel(row.finding.lastSeenAt)}
          </span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <SeverityBadge severity={row.finding.severity} />
          <ProgressBadge progress={row.progress} />
          <span className="truncate">{source}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{row.environmentLabel}</span>
          {row.finding.seenCount > 1 ? (
            <>
              <span aria-hidden>·</span>
              <span>seen {row.finding.seenCount}×</span>
            </>
          ) : null}
        </span>
      </button>
    </li>
  );
});

export function TodayList({
  groups,
  taskTitles,
  highlightedKey,
  openKey,
  emptyTitle,
  emptyDescription,
  onHighlight,
  onOpen,
}: {
  groups: ReadonlyArray<FindingGroup<WatcherFindingRow>>;
  taskTitles: ReadonlyMap<string, string>;
  highlightedKey: string | null;
  openKey: string | null;
  emptyTitle: string;
  emptyDescription: string;
  onHighlight: (key: string) => void;
  onOpen: (key: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightedKey === null) return;
    listRef.current
      ?.querySelector(`[data-finding-key="${CSS.escape(highlightedKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedKey]);

  const shown = groups.filter((group) => group.items.length > 0);
  if (shown.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div ref={listRef} className="flex flex-col gap-4">
      {shown.map((group) => (
        <section key={group.key} aria-labelledby={`watchers-group-${group.key}`}>
          <h2
            id={`watchers-group-${group.key}`}
            className="flex items-center gap-2 px-3 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {group.label}
            <span className="font-medium tabular-nums">{group.items.length}</span>
          </h2>
          <ul className="flex flex-col">
            {group.items.map((row) => (
              <FindingRow
                key={row.key}
                row={row}
                highlighted={row.key === highlightedKey}
                open={row.key === openKey}
                source={sourceLabel(row, taskTitles)}
                onHighlight={onHighlight}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
