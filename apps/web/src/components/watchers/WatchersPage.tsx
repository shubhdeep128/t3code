import { useAtomValue } from "@effect/atom-react";
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
  watcherClockAtom,
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

type View = "today" | "backlog" | "runs" | "watchers";

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "today", label: "Today" },
  { value: "backlog", label: "Backlog" },
  { value: "runs", label: "Runs" },
  { value: "watchers", label: "Watchers" },
];

const isView = (value: unknown): value is View => VIEWS.some((option) => option.value === value);

/** Nothing chosen yet shows the first row; closed shows none until the next choice. */
type Selection = { kind: "auto" } | { kind: "key"; key: string } | { kind: "none" };

export function WatchersPage() {
  const environments = useWatcherEnvironments();
  const findings = useWatcherFindings(environments);
  const tasks = useWatcherTasks(environments);
  const firings = useWatcherFirings(environments, tasks);
  const projects = useProjects();
  const nowMs = useAtomValue(watcherClockAtom);
  const navigateToMainApp = useNavigateToMainApp();
  useRecordMergedWork(findings.rows);

  const [view, setView] = useState<View>("today");
  const [selection, setSelection] = useState<Selection>({ kind: "auto" });
  const [fixOn, setFixOn] = useState<{ key: string; mode: StartFindingWorkMode } | null>(null);
  const listView = view === "today" || view === "backlog";
  const showEnvironment = environments.length > 1;

  const environmentLabels = useMemo(
    () => new Map(environments.map((entry) => [entry.environmentId, entry.label])),
    [environments],
  );
  const environmentLabelFor = (environmentId: EnvironmentId) =>
    environmentLabels.get(environmentId) ?? "another machine";

  const taskRows = useMemo(
    () =>
      tasks.values.flatMap(([environmentId, result]) =>
        result.tasks.map((task) => ({ environmentId, task })),
      ),
    [tasks.values],
  );
  const taskTitles = useMemo(
    () =>
      new Map(
        taskRows.map(({ environmentId, task }) => [`${environmentId}:${task.id}`, task.title]),
      ),
    [taskRows],
  );
  const taskFor = (row: WatcherFindingRow) =>
    row.finding.source.type === "scheduled_task"
      ? (taskRows.find(
          (entry) =>
            entry.environmentId === row.environmentId &&
            row.finding.source.type === "scheduled_task" &&
            entry.task.id === row.finding.source.taskId,
        )?.task ?? null)
      : null;

  const groups = useMemo(() => groupFindings(findings.rows), [findings.rows]);
  const shownGroups = useMemo(
    () =>
      groups.filter((group) =>
        view === "backlog" ? !TODAY_GROUP_KEYS.has(group.key) : TODAY_GROUP_KEYS.has(group.key),
      ),
    [groups, view],
  );
  const orderedKeys = useMemo(
    () => shownGroups.flatMap((group) => group.items.map((row) => row.key)),
    [shownGroups],
  );
  const rowFor = (key: string | undefined) =>
    key === undefined ? null : (findings.rows.find((row) => row.key === key) ?? null);
  const selected =
    selection.kind === "none"
      ? null
      : selection.kind === "key" && orderedKeys.includes(selection.key)
        ? rowFor(selection.key)
        : rowFor(orderedKeys[0]);
  const select = useCallback((key: string) => setSelection({ kind: "key", key }), []);

  const sourceTask = selected === null ? null : taskFor(selected);
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
  const fixOnRow = fixOn === null ? null : rowFor(fixOn.key);

  const detailRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyActions = useRef<RunFindingAction | null>(null);
  const registerKeyActions = useCallback((run: RunFindingAction | null) => {
    keyActions.current = run;
  }, []);

  // Letter keys belong to the list: they run only with focus on the page body
  // or a row, so a focused button or link keeps its own Enter and letters.
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
        fixOn !== null
      ) {
        return;
      }
      const focus = document.activeElement;
      const inList = focus === document.body || (listRef.current?.contains(focus) ?? false);
      const inDetail = detailRef.current?.contains(focus) ?? false;
      if (event.key === "Escape" && (inList || inDetail)) {
        event.preventDefault();
        if (inDetail) {
          listRef.current
            ?.querySelector<HTMLElement>(`[data-finding-key="${CSS.escape(selected?.key ?? "")}"]`)
            ?.focus();
          return;
        }
        if (focus instanceof HTMLElement) focus.blur();
        navigateToMainApp();
        return;
      }
      if (!listView || !inList) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        if (orderedKeys.length === 0) return;
        const index = selected === null ? -1 : orderedKeys.indexOf(selected.key);
        const next =
          event.key === "j" ? Math.min(index + 1, orderedKeys.length - 1) : Math.max(index - 1, 0);
        select(orderedKeys[next]!);
        return;
      }
      if (selected === null) return;
      if (event.key === "Enter") {
        event.preventDefault();
        detailRef.current?.scrollIntoView({ block: "nearest" });
        detailRef.current
          ?.querySelector<HTMLElement>("[data-finding-actions] button:not([disabled])")
          ?.focus();
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
  }, [listView, fixOn, orderedKeys, selected, select, navigateToMainApp]);

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
        value={[view]}
        onValueChange={(next) => {
          if (isView(next[0])) setView(next[0]);
        }}
      >
        {VIEWS.map((option) => (
          <Toggle key={option.value} value={option.value}>
            {option.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {showEnvironment ? (
        <span className="ms-auto hidden min-w-0 truncate text-xs text-muted-foreground md:block">
          {environments.length} environments
        </span>
      ) : null}
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
            ) : view === "watchers" ? (
              <WatcherCards
                environments={environments}
                tasks={taskRows}
                firings={firingRows}
                findings={findings.rows}
                loading={tasks.values.length === 0 && tasks.error === null}
                error={tasks.values.length === 0 ? tasks.error : null}
                showEnvironment={showEnvironment}
                onRan={() => firings.refresh()}
              />
            ) : view === "runs" ? (
              <FiringsList
                firings={firingRows}
                taskTitles={taskTitles}
                showEnvironment={showEnvironment}
              />
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
                <div ref={listRef} className="min-w-0" aria-busy={findings.isPending}>
                  <TodayList
                    groups={shownGroups}
                    taskTitles={taskTitles}
                    selectedKey={selected?.key ?? null}
                    showEnvironment={showEnvironment}
                    nowMs={nowMs}
                    emptyTitle={
                      findings.isPending && findings.rows.length === 0
                        ? "Loading findings…"
                        : view === "backlog"
                          ? "Nothing in the backlog"
                          : "Nothing to do"
                    }
                    emptyDescription={
                      view === "backlog"
                        ? "Backlogged and dismissed findings wait here until you restore them."
                        : "When a watcher files a finding, or a worker needs you, it shows here."
                    }
                    onSelect={select}
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
                      showEnvironment={showEnvironment}
                      onRunReady={registerKeyActions}
                      onFixOn={(mode) => setFixOn({ key: selected.key, mode })}
                      onClose={() => setSelection({ kind: "none" })}
                    />
                  )}
                </div>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {fixOn !== null && fixOnRow !== null ? (
        <FixOnDialog
          row={fixOnRow}
          mode={fixOn.mode}
          environments={environments}
          sourceTask={taskFor(fixOnRow)}
          onClose={() => setFixOn(null)}
        />
      ) : null}
    </SidebarInset>
  );
}
