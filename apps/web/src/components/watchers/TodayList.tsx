import { memo, useEffect, useRef } from "react";

import type { FindingGroup } from "@t3tools/client-runtime/state/finding-groups";

import { cn } from "../../lib/utils";
import type { WatcherFindingRow } from "../../state/watchers";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ProgressBadge, SeverityBadge } from "./findingPresentation";
import { findingSourceLabel } from "./findingSource.logic";

const FindingRow = memo(function FindingRow({
  row,
  selected,
  source,
  showEnvironment,
  onSelect,
}: {
  row: WatcherFindingRow;
  selected: boolean;
  source: string | null;
  showEnvironment: boolean;
  onSelect: (key: string) => void;
}) {
  const notes = [
    source,
    showEnvironment ? row.environmentLabel : null,
    row.finding.seenCount > 1 ? `seen ${row.finding.seenCount}×` : null,
  ].filter((note) => note !== null);
  return (
    <li>
      <button
        type="button"
        data-finding-key={row.key}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-1 rounded-md border-l-2 border-transparent px-3 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "border-primary bg-accent",
        )}
        onFocus={() => onSelect(row.key)}
        onClick={() => onSelect(row.key)}
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
          {notes.map((note, index) => (
            <span key={note} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? <span aria-hidden>·</span> : null}
              <span className="truncate">{note}</span>
            </span>
          ))}
        </span>
      </button>
    </li>
  );
});

export function TodayList({
  groups,
  taskTitles,
  selectedKey,
  showEnvironment,
  emptyTitle,
  emptyDescription,
  onSelect,
}: {
  groups: ReadonlyArray<FindingGroup<WatcherFindingRow>>;
  taskTitles: ReadonlyMap<string, string>;
  selectedKey: string | null;
  showEnvironment: boolean;
  emptyTitle: string;
  emptyDescription: string;
  onSelect: (key: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedKey === null) return;
    listRef.current
      ?.querySelector(`[data-finding-key="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

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
                selected={row.key === selectedKey}
                source={findingSourceLabel(row.finding.source, row.environmentId, taskTitles)}
                showEnvironment={showEnvironment}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
