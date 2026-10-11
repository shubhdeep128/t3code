import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type FindingTriage,
  type PullRequestRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { pullRequestEnvironment } from "../../state/pullRequests";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { WatcherFindingRow } from "../../state/watchers";
import { useUiStateStore } from "../../uiStateStore";
import { resolvePullRequestMergeMethod } from "../pullRequest/pullRequestDetail.logic";
import {
  usePullRequestActionRunner,
  usePullRequestDefaultMergeMethodResolver,
} from "../pullRequest/usePullRequestActions";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { RUNNING_KINDS, findingActions, type FindingActionKey } from "./findingPresentation";
import type { StartFindingWorkMode } from "./fixOn.logic";

const ACTION_LABELS: Record<FindingActionKey, { label: string; key: string | null }> = {
  fix: { label: "Fix on", key: "f" },
  start_again: { label: "Start again", key: "f" },
  stop_work: { label: "Stop work", key: null },
  merge: { label: "Merge", key: "m" },
  backlog: { label: "Backlog", key: "b" },
  restore: { label: "Restore", key: "b" },
  dismiss: { label: "Dismiss", key: "d" },
  reopen: { label: "Reopen", key: "d" },
};

const ACTION_ORDER: ReadonlyArray<FindingActionKey> = [
  "merge",
  "fix",
  "start_again",
  "restore",
  "reopen",
  "stop_work",
  "backlog",
  "dismiss",
];

export function workerPullRequest(row: WatcherFindingRow): ThreadPullRequestLink | null {
  return "pr" in row.progress ? row.progress.pr : null;
}

export function pullRequestReference(row: WatcherFindingRow): PullRequestRef | null {
  const pr = workerPullRequest(row);
  if (pr === null || row.work === null) return null;
  return {
    projectId: row.work.projectId,
    host: pr.host,
    repository: pr.repository,
    number: pr.number,
  };
}

export type RunFindingAction = (action: FindingActionKey) => void;

/** Merge asks twice within three seconds, the way the pull request view confirms it. */
function useArmedMerge() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const disarm = () => setArmed(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      disarm();
    };
    const timeout = window.setTimeout(disarm, 3000);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", disarm);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", disarm);
    };
  }, [armed]);
  return { armed, setArmed };
}

/**
 * Every action a finding offers and the permission each needs. Triage writes
 * go to the finding's environment; stopping and merging go to the worker's,
 * and nothing is written after a step on the worker fails.
 * `onRunReady` hands the page the runner, so letter keys share this path.
 */
export function FindingActions({
  row,
  onRunReady,
  onFixOn,
}: {
  row: WatcherFindingRow;
  onRunReady?: (run: RunFindingAction | null) => void;
  onFixOn: (mode: StartFindingWorkMode) => void;
}) {
  const workThread = row.finding.workThread;
  const workEnvironmentId = workThread?.environmentId ?? null;
  const canOperate = useAtomValue(
    serverEnvironment.updateFinding.permissionAtom(row.environmentId),
  );
  const canOperateWorker = useEnvironmentScope(workEnvironmentId, AuthOrchestrationOperateScope);
  const canMerge = useAtomValue(pullRequestEnvironment.runAction.permissionAtom(workEnvironmentId));
  const updateFinding = useAtomCommand(serverEnvironment.updateFinding, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const resolveProjectDefault = usePullRequestDefaultMergeMethodResolver(
    workEnvironmentId ?? row.environmentId,
    row.work?.projectId ?? row.finding.projectId,
  );
  const pullRequest = usePullRequestActionRunner({
    environmentId: workEnvironmentId ?? row.environmentId,
    reference: pullRequestReference(row),
    resolveMergeMethod: (detail) => {
      const allowed = detail.capabilities.mergeMethods.filter(
        (method) => detail.mergeCapabilities[method],
      );
      if (allowed.length === 0)
        throw new Error("No merge method is available for this repository.");
      return resolvePullRequestMergeMethod(
        allowed,
        null,
        resolveProjectDefault(),
        useUiStateStore.getState().pullRequestMergeMethod,
      );
    },
  });
  const merge = useArmedMerge();
  const [busy, setBusy] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);

  const offered = findingActions(row.progress);
  const enabled = (action: FindingActionKey) =>
    offered.has(action) &&
    !busy &&
    !pullRequest.actionPending &&
    (action === "merge"
      ? canMerge
      : action === "stop_work"
        ? canOperate && canOperateWorker
        : canOperate);

  const report = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });

  const setTriage = async (triage: FindingTriage) => {
    const result = await updateFinding({
      environmentId: row.environmentId,
      input: { findingId: row.finding.findingId, triage },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      report("Could not update the finding", squashAtomCommandFailure(result));
    }
  };

  const stopWorker = async (): Promise<boolean> => {
    if (workThread === null) return true;
    if (!readEnvironmentScope(workThread.environmentId, AuthOrchestrationOperateScope)) {
      report(
        "Could not stop the worker",
        new Error("You cannot operate threads on the worker's environment."),
      );
      return false;
    }
    const result = await interruptTurn({
      environmentId: workThread.environmentId,
      input: { threadId: workThread.threadId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        report("Could not stop the worker", squashAtomCommandFailure(result));
      }
      return false;
    }
    return true;
  };

  const closeWorkerPullRequest = async (): Promise<boolean> =>
    workerPullRequest(row)?.snapshot?.state === "open" ? pullRequest.perform("close") : true;

  const run: RunFindingAction = async (action) => {
    if (
      !enabled(action) ||
      !readEnvironmentScope(row.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    if (action === "fix" || action === "start_again") {
      onFixOn({ kind: "claim", expectedWorkAttempt: row.finding.workAttempt });
      return;
    }
    if (action === "dismiss" && RUNNING_KINDS.has(row.progress.kind)) {
      setConfirmDismiss(true);
      return;
    }
    if (action === "merge" && !merge.armed) {
      merge.setArmed(true);
      return;
    }
    merge.setArmed(false);
    setBusy(true);
    try {
      if (action === "merge") {
        await pullRequest.perform("merge");
      } else if (action === "stop_work") {
        if (!(await stopWorker())) return;
        const result = await updateFinding({
          environmentId: row.environmentId,
          input: {
            findingId: row.finding.findingId,
            claim: { workThread: null, expectedWorkAttempt: row.finding.workAttempt },
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          report("Could not detach the worker", squashAtomCommandFailure(result));
        }
      } else {
        await setTriage(
          action === "backlog" ? "backlog" : action === "dismiss" ? "dismissed" : "open",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (stop: boolean) => {
    setConfirmDismiss(false);
    setBusy(true);
    try {
      if (stop && !((await stopWorker()) && (await closeWorkerPullRequest()))) return;
      await setTriage("dismissed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    onRunReady?.(run);
    return () => onRunReady?.(null);
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" data-finding-actions>
        {ACTION_ORDER.filter((action) => offered.has(action)).map((action, index) => {
          const { label, key } = ACTION_LABELS[action];
          return (
            <Button
              key={action}
              size="xs"
              variant={index === 0 ? "default" : "outline"}
              aria-label={label}
              disabled={!enabled(action)}
              onClick={() => void run(action)}
            >
              {action === "merge" && merge.armed ? "Confirm merge?" : label}
              {key !== null ? <Kbd>{key}</Kbd> : null}
            </Button>
          );
        })}
      </div>
      <AlertDialog open={confirmDismiss} onOpenChange={setConfirmDismiss}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss this finding?</AlertDialogTitle>
            <AlertDialogDescription>
              A worker is still on it. Stop the worker and close its pull request, or leave it
              running and only hide the finding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="outline" onClick={() => void dismiss(false)}>
              Dismiss only
            </Button>
            <Button
              variant="destructive"
              disabled={!canOperateWorker}
              onClick={() => void dismiss(true)}
            >
              Stop the worker and dismiss
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
