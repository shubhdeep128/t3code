import { TODAY_GROUP_KEYS, groupFindings } from "@t3tools/client-runtime/state/finding-groups";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useProjects } from "../../state/entities";
import {
  useRecordMergedWork,
  useWatcherEnvironments,
  useWatcherFindings,
  useWatcherFirings,
  useWatcherTasks,
  type WatcherFindingRow,
} from "../../state/watchers";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import type { RunFindingAction } from "./FindingActions";
import { FindingDetailPanel } from "./FindingDetailPanel";
import { FiringsList, type WatcherFiringRow } from "./FiringsList";
import { FixOnDialog } from "./FixOnDialog";
import { TodayList } from "./TodayList";
import { WatcherCards } from "./WatcherCards";
import { actionForKey, findingActions } from "./findingPresentation";
import type { StartFindingWorkMode } from "./fixOn.logic";

type Tab = "today" | "watchers";
type TodayFilter = "today" | "backlog" | "runs";

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "today", label: "Today" },
  { value: "watchers", label: "Watchers" },
];
const FILTERS: ReadonlyArray<{ value: TodayFilter; label: string }> = [
  { value: "today", label: "Today" },
  { value: "backlog", label: "Backlog" },
  { value: "runs", label: "Runs" },
];

const isTab = (value: unknown): value is Tab => value === "today" || value === "watchers";
const isFilter = (value: unknown): value is TodayFilter =>
  value === "today" || value === "backlog" || value === "runs";

/** Letter keys stay out of fields and open popups, like the Usage page's shortcuts. */
function keyboardTargetIsFree(target: EventTarget | null) {
  return !(
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]'))
  );
}

export function WatchersPage() {
  const environments = useWatcherEnvironments();
  const findings = useWatcherFindings(environments);
  const tasks = useWatcherTasks(environments);
  const firings = useWatcherFirings(environments);
  const projects = useProjects();
  const navigateToMainApp = useNavigateToMainApp();
  useRecordMergedWork(findings.rows);

  const [tab, setTab] = useState<Tab>("today");
  const [filter, setFilter] = useState<TodayFilter>("today");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [fixOn, setFixOn] = useState<{ row: WatcherFindingRow; mode: StartFindingWorkMode } | null>(
    null,
  );

  const environmentLabels = useMemo(
    () => new Map(environments.map((entry) => [entry.environmentId, entry.label])),
    [environments],
  );
  const environmentLabelFor = (environmentId: EnvironmentId) =>
    environmentLabels.get(environmentId) ?? "another machine";

  const taskTitles = useMemo(
    () =>
      new Map(
        tasks.values.flatMap(([environmentId, result]) =>
          result.tasks.map((task) => [`${environmentId}:${task.id}`, task.title] as const),
        ),
      ),
    [tasks.values],
  );

  const groups = useMemo(() => groupFindings(findings.rows), [findings.rows]);
  const shownGroups = useMemo(
    () =>
      groups.filter((group) =>
        filter === "backlog" ? !TODAY_GROUP_KEYS.has(group.key) : TODAY_GROUP_KEYS.has(group.key),
      ),
    [groups, filter],
  );
  const orderedKeys = useMemo(
    () => shownGroups.flatMap((group) => group.items.map((row) => row.key)),
    [shownGroups],
  );
  const selected =
    (selectedKey !== null && orderedKeys.includes(selectedKey)
      ? findings.rows.find((row) => row.key === selectedKey)
      : undefined) ??
    (orderedKeys[0] === undefined
      ? null
      : (findings.rows.find((row) => row.key === orderedKeys[0]) ?? null));

  const sourceTask =
    selected !== null && selected.finding.source.type === "scheduled_task"
      ? (tasks.values
          .find(([environmentId]) => environmentId === selected.environmentId)?.[1]
          .tasks.find(
            (task) =>
              selected.finding.source.type === "scheduled_task" &&
              task.id === selected.finding.source.taskId,
          ) ?? null)
      : null;
  const firingRows = useMemo(
    (): ReadonlyArray<WatcherFiringRow> =>
      firings.values.flatMap(([environmentId, result]) =>
        result.firings.map((firing) => ({
          environmentId,
          environmentLabel: environmentLabels.get(environmentId) ?? "another machine",
          firing,
        })),
      ),
    [firings.values, environmentLabels],
  );
  const sourceFiring =
    sourceTask === null || selected === null
      ? null
      : (firingRows
          .filter(
            (entry) =>
              entry.environmentId === selected.environmentId &&
              entry.firing.taskId === sourceTask.id,
          )
          .reduce<WatcherFiringRow | null>(
            (newest, entry) =>
              newest === null ||
              Date.parse(entry.firing.firedAt) > Date.parse(newest.firing.firedAt)
                ? entry
                : newest,
            null,
          )?.firing ?? null);
  const selectedProject =
    selected === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === selected.environmentId &&
            project.id === selected.finding.projectId,
        ) ?? null);

  const taskRows = useMemo(
    () =>
      tasks.values.flatMap(([environmentId, result]) =>
        result.tasks.map((task) => ({ environmentId, task })),
      ),
    [tasks.values],
  );

  const detailRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyActions = useRef<RunFindingAction | null>(null);
  const registerKeyActions = useCallback((run: RunFindingAction | null) => {
    keyActions.current = run;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isCommandPaletteOpen() ||
        !keyboardTargetIsFree(event.target)
      ) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (detailRef.current?.contains(document.activeElement)) {
          listRef.current
            ?.querySelector<HTMLElement>(`[data-finding-key="${CSS.escape(selected?.key ?? "")}"]`)
            ?.focus();
          return;
        }
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        navigateToMainApp();
        return;
      }
      if (tab !== "today" || filter === "runs" || fixOn !== null) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        if (orderedKeys.length === 0) return;
        const index = selected === null ? -1 : orderedKeys.indexOf(selected.key);
        const next =
          event.key === "j" ? Math.min(index + 1, orderedKeys.length - 1) : Math.max(index - 1, 0);
        setSelectedKey(orderedKeys[next] ?? null);
        return;
      }
      if (selected === null) return;
      if (event.key === "Enter") {
        event.preventDefault();
        detailRef.current?.scrollIntoView({ block: "nearest" });
        detailRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
        return;
      }
      const action = actionForKey(event.key, findingActions(selected.progress));
      if (action !== null) {
        event.preventDefault();
        keyActions.current?.(action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, filter, fixOn, orderedKeys, selected, navigateToMainApp]);

  const openFixOn = (row: WatcherFindingRow) => (mode: StartFindingWorkMode) =>
    setFixOn({ row, mode });

  const topbar = (
    <div className="flex w-full min-w-0 items-center gap-3 py-2">
      <WorkspaceBreadcrumb ariaLabel="Watchers breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Watchers</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <ToggleGroup
        aria-label="Watchers view"
        variant="segmented"
        value={[tab]}
        onValueChange={(next) => {
          if (isTab(next[0])) setTab(next[0]);
        }}
      >
        {TABS.map((option) => (
          <Toggle key={option.value} value={option.value}>
            {option.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {tab === "today" ? (
        <ToggleGroup
          aria-label="Today filter"
          variant="segmented"
          value={[filter]}
          onValueChange={(next) => {
            if (isFilter(next[0])) setFilter(next[0]);
          }}
        >
          {FILTERS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      <span className="ms-auto hidden min-w-0 truncate text-xs text-muted-foreground md:block">
        {environments.length === 0
          ? "No environment connected"
          : environments.length === 1
            ? environments[0]!.label
            : `${environments.length} environments`}
      </span>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbar}</WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {findings.errors.map((error) => (
              <p key={error.label} className="text-sm text-destructive" role="status">
                {error.label}: {error.message}
              </p>
            ))}
            {environments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment to see what its watchers found.
              </p>
            ) : tab === "watchers" ? (
              <WatcherCards
                environments={environments}
                tasks={taskRows}
                firings={firingRows}
                findings={findings.rows}
                loading={tasks.isPending}
                onRan={() => firings.refresh()}
              />
            ) : filter === "runs" ? (
              <FiringsList firings={firingRows} taskTitles={taskTitles} />
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
                <div ref={listRef} className="min-w-0" aria-busy={findings.isPending}>
                  <TodayList
                    groups={shownGroups}
                    taskTitles={taskTitles}
                    highlightedKey={selected?.key ?? null}
                    openKey={selected?.key ?? null}
                    emptyTitle={
                      findings.isPending
                        ? "Loading findings…"
                        : filter === "backlog"
                          ? "Nothing in the backlog"
                          : "Nothing to do"
                    }
                    emptyDescription={
                      filter === "backlog"
                        ? "Backlogged and dismissed findings wait here until you restore them."
                        : "When a watcher files a finding, or a worker needs you, it shows here."
                    }
                    onHighlight={setSelectedKey}
                    onOpen={setSelectedKey}
                  />
                </div>
                <div ref={detailRef} className="min-w-0">
                  {selected === null ? null : (
                    <FindingDetailPanel
                      key={selected.key}
                      row={selected}
                      project={selectedProject}
                      sourceTask={sourceTask}
                      sourceFiring={sourceFiring}
                      environmentLabelFor={environmentLabelFor}
                      onRunReady={registerKeyActions}
                      onFixOn={openFixOn(selected)}
                      onClose={() => setSelectedKey(null)}
                    />
                  )}
                </div>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {fixOn ? (
        <FixOnDialog
          row={fixOn.row}
          mode={fixOn.mode}
          environments={environments}
          sourceTask={
            fixOn.row.finding.source.type === "scheduled_task"
              ? (tasks.values
                  .find(([environmentId]) => environmentId === fixOn.row.environmentId)?.[1]
                  .tasks.find(
                    (task) =>
                      fixOn.row.finding.source.type === "scheduled_task" &&
                      task.id === fixOn.row.finding.source.taskId,
                  ) ?? null)
              : null
          }
          onClose={() => setFixOn(null)}
        />
      ) : null}
    </SidebarInset>
  );
}
