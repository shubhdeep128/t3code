import { useAtomValue } from "@effect/atom-react";
import { deriveFindingProgress, type FindingWork } from "@t3tools/shared/findingProgress";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type Finding,
  type FindingProgress,
  type OrchestrationV2ThreadShell,
  type ScheduledTaskFiringView,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { useEnvironments, type EnvironmentPresentation } from "./environments";
import { createMergedEnvironmentQuery } from "./pullRequests";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";
import { readEnvironmentScope } from "./session";
import { environmentThreadShells } from "./threads";
import { useAtomCommand } from "./use-atom-command";

/** The environments the page reads. Only connected ones can answer. */
export function useWatcherEnvironments(): ReadonlyArray<EnvironmentPresentation> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" && environment.serverConfig !== null,
      ),
    [environments],
  );
}

export interface WatcherFindingRow {
  /** Environment and finding id, unique across the merged list. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly finding: Finding;
  readonly progress: FindingProgress;
  /** The worker's shell when it runs in a connected environment. */
  readonly work: OrchestrationV2ThreadShell | null;
}

export interface WatcherFindingsView {
  readonly rows: ReadonlyArray<WatcherFindingRow>;
  /** Some environment has not sent its first list yet. */
  readonly isPending: boolean;
  readonly errors: ReadonlyArray<{ readonly label: string; readonly message: string }>;
}

interface FindingsKey {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * The minute, for stalled workers and relative ages. Ticks only while the
 * page reads it, and once for every row at a time.
 */
export const watcherClockAtom = Atom.make((get) => {
  const timer = setInterval(() => get.setSelf(Date.now()), 60_000);
  get.addFinalizer(() => clearInterval(timer));
  return Date.now();
}).pipe(Atom.withLabel("web-watchers:clock"));

const progressEqual = (a: FindingProgress, b: FindingProgress) =>
  a.kind === b.kind &&
  ("stalled" in a ? a.stalled === (b as typeof a).stalled : true) &&
  ("reason" in a ? a.reason === (b as typeof a).reason : true) &&
  ("pr" in a ? a.pr === (b as typeof a).pr : true);

/**
 * Every connected environment's findings in one list, each with the progress
 * of its worker read from whichever environment the work runs in. Rows keep
 * their identity while their finding, worker shell and progress are unchanged,
 * so a shell update elsewhere does not re-render the whole list.
 */
const watcherFindingsFamily = Atom.family((key: string) => {
  let previous = new Map<string, WatcherFindingRow>();
  let previousRows: ReadonlyArray<WatcherFindingRow> = [];
  return Atom.make((get): WatcherFindingsView => {
    const environments = JSON.parse(key) as ReadonlyArray<FindingsKey>;
    const connected = new Set(environments.map((environment) => environment.environmentId));
    const now = DateTime.makeUnsafe(get(watcherClockAtom));
    const next = new Map<string, WatcherFindingRow>();
    const rows: WatcherFindingRow[] = [];
    const errors: Array<{ label: string; message: string }> = [];
    let isPending = false;
    let changed = false;
    for (const environment of environments) {
      const result = get(
        serverEnvironment.findingsLive({ environmentId: environment.environmentId, input: {} }),
      );
      if (result._tag === "Failure") {
        errors.push({
          label: environment.label,
          message: formatEnvironmentQueryError(result.cause),
        });
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      // A live stream keeps `waiting` set between emissions, so pending means
      // an environment has not sent its first list yet.
      if (value === null) {
        isPending ||= result._tag !== "Failure";
        continue;
      }
      for (const finding of value.findings) {
        let work: OrchestrationV2ThreadShell | null = null;
        let found: FindingWork = { kind: "unreachable" };
        if (finding.workThread !== null && connected.has(finding.workThread.environmentId)) {
          work =
            get(
              environmentThreadShells.environmentThreadIndexAtom(finding.workThread.environmentId),
            ).get(finding.workThread.threadId) ?? null;
          found = work === null ? { kind: "missing" } : { kind: "shell", shell: work };
        }
        const progress = deriveFindingProgress(finding, found, now);
        const rowKey = `${environment.environmentId}:${finding.findingId}`;
        const before = previous.get(rowKey);
        const row =
          before !== undefined &&
          before.finding === finding &&
          before.work === work &&
          before.environmentLabel === environment.label &&
          progressEqual(before.progress, progress)
            ? before
            : {
                key: rowKey,
                environmentId: environment.environmentId,
                environmentLabel: environment.label,
                finding,
                progress,
                work,
              };
        changed ||= row !== before;
        next.set(rowKey, row);
        rows.push(row);
      }
    }
    previous = next;
    if (changed || rows.length !== previousRows.length) previousRows = rows;
    return { rows: previousRows, isPending, errors };
  }).pipe(Atom.withLabel(`web-watchers:findings:${key}`));
});

const emptyFindings = Atom.make<WatcherFindingsView>({
  rows: [],
  isPending: false,
  errors: [],
}).pipe(Atom.withLabel("web-watchers:findings:empty"));

export function useWatcherFindings(
  environments: ReadonlyArray<EnvironmentPresentation>,
): WatcherFindingsView {
  const key = JSON.stringify(
    environments.map((environment): FindingsKey => ({
      environmentId: environment.environmentId,
      label: environment.label,
    })),
  );
  return useAtomValue(environments.length === 0 ? emptyFindings : watcherFindingsFamily(key));
}

const useMergedTasks = createMergedEnvironmentQuery(
  "web-watchers:tasks",
  serverEnvironment.scheduledTasksLive,
);

const useMergedFirings = createMergedEnvironmentQuery(
  "web-watchers:firings",
  serverEnvironment.scheduledTaskFirings,
);

const FIRINGS_LIMIT = 200;

export function useWatcherTasks(environments: ReadonlyArray<EnvironmentPresentation>) {
  return useMergedTasks(
    useMemo(
      () =>
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          input: {},
        })),
      [environments],
    ),
  );
}

const IN_PROGRESS_RUN = new Set<ScheduledTaskFiringView["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Run steps the given threads have finished, read from their shells: one when
 * a thread's turn ends, and one more when its background work settles, which
 * is when its run leaves "waiting". It rises with each step.
 */
const settledRunStepsFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    let steps = 0;
    for (const [environmentId, threadId] of JSON.parse(key) as ReadonlyArray<
      readonly [EnvironmentId, ThreadId]
    >) {
      const shell = get(environmentThreadShells.environmentThreadIndexAtom(environmentId)).get(
        threadId,
      );
      if (shell === undefined) continue;
      if (shell.activeRunId === null) steps += 1;
      if ((shell.activityRunStatus ?? null) === null) steps += 1;
    }
    return steps;
  }).pipe(Atom.withLabel(`web-watchers:settled-run-steps:${key}`)),
);

/**
 * Firings are a one-shot query, and the server reads each run's outcome only
 * when asked. Refetch when a task changes, which is when firings are written,
 * and each time the thread behind an in-progress firing ends its turn or
 * settles its background work.
 */
export function useWatcherFirings(
  environments: ReadonlyArray<EnvironmentPresentation>,
  tasks: { readonly observations: ReadonlyArray<readonly [EnvironmentId, unknown, number]> },
) {
  const firings = useMergedFirings(
    useMemo(
      () =>
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          input: { limit: FIRINGS_LIMIT },
        })),
      [environments],
    ),
  );
  const { refresh } = firings;
  const tasksVersion = tasks.observations
    .map(([environmentId, , observedAt]) => `${environmentId}:${observedAt}`)
    .join(",");
  const awaiting = JSON.stringify(
    firings.values.flatMap(([environmentId, result]) =>
      result.firings.flatMap((firing) =>
        IN_PROGRESS_RUN.has(firing.status) && firing.threadId !== null
          ? [[environmentId, firing.threadId] as const]
          : [],
      ),
    ),
  );
  const settledSteps = useAtomValue(settledRunStepsFamily(awaiting));
  const seenTasksVersion = useRef(tasksVersion);
  useEffect(() => {
    if (seenTasksVersion.current === tasksVersion) return;
    seenTasksVersion.current = tasksVersion;
    refresh();
  }, [tasksVersion, refresh]);
  useEffect(() => {
    if (settledSteps > 0) refresh();
  }, [settledSteps, awaiting, refresh]);
  return firings;
}

/**
 * The client that sees a worker's pull request merge writes `workMergedAt`
 * once, so the finding reads merged on every client and a repeat report opens
 * a new finding. The server keeps the first value, so a second write is moot.
 */
export function useRecordMergedWork(rows: ReadonlyArray<WatcherFindingRow>) {
  const updateFinding = useAtomCommand(serverEnvironment.updateFinding, { reportFailure: false });
  const written = useRef(new Set<string>());
  useEffect(() => {
    for (const row of rows) {
      if (
        row.progress.kind !== "merged" ||
        row.finding.workMergedAt !== null ||
        row.finding.workThread === null ||
        written.current.has(row.key) ||
        !readEnvironmentScope(row.environmentId, AuthOrchestrationOperateScope)
      ) {
        continue;
      }
      written.current.add(row.key);
      const mergedAt = Date.parse(row.progress.pr?.snapshot?.mergedAt ?? "");
      void updateFinding({
        environmentId: row.environmentId,
        input: {
          findingId: row.finding.findingId,
          workMergedAt: new Date(Number.isNaN(mergedAt) ? Date.now() : mergedAt).toISOString(),
        },
      });
    }
  }, [rows, updateFinding]);
}
