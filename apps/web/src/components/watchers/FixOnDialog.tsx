import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FindingClaimConflict,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useId, useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { WatcherFindingRow } from "../../state/watchers";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  findingWorkBranch,
  findingWorkBrief,
  startFindingWork,
  type StartFindingWorkMode,
} from "./fixOn.logic";

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "conflict" }
  | { kind: "error"; message: string; retry: StartFindingWorkMode };

const isClaimConflict = Schema.is(FindingClaimConflict);

/**
 * Sends a finding to a worker on any connected environment. The claim lands
 * on the finding's own server first, then the thread starts where the user
 * chose, in a worktree off the base branch, with the finding as its brief.
 */
export function FixOnDialog({
  row,
  mode: initialMode,
  environments,
  sourceTask,
  onClose,
}: {
  row: WatcherFindingRow;
  mode: StartFindingWorkMode;
  environments: ReadonlyArray<EnvironmentPresentation>;
  sourceTask: ScheduledTask | null;
  onClose: () => void;
}) {
  const id = useId();
  const allProjects = useProjects();
  const findingProject = allProjects.find(
    (project) =>
      project.environmentId === row.environmentId && project.id === row.finding.projectId,
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId>(row.environmentId);
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  // The same project on another machine usually carries the same name.
  const [projectChoice, setProjectChoice] = useState<ProjectId | null>(null);
  const project =
    projects.find((candidate) => candidate.id === projectChoice) ??
    projects.find((candidate) => candidate.title === findingProject?.title) ??
    projects[0] ??
    null;
  const sourceBaseRef =
    sourceTask?.workspaceStrategy.type === "worktree" ? sourceTask.workspaceStrategy.baseRef : null;
  const [baseBranch, setBaseBranch] = useState(sourceBaseRef ?? "main");
  const [startFromOrigin, setStartFromOrigin] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  // The watcher's own model, when the chosen environment has it, then the
  // project or environment default, then the first available model.
  const [modelChoice, setModelChoice] = useState<ModelSelection | null>(null);
  const sourceModel = sourceTask?.modelSelection ?? null;
  const hasModel = (selection: ModelSelection) =>
    instanceEntries.some(
      (entry) =>
        entry.instanceId === selection.instanceId &&
        entry.models.some((model) => model.slug === selection.model),
    );
  const modelSelection: ModelSelection | null =
    modelChoice ??
    (sourceModel !== null && hasModel(sourceModel) ? sourceModel : null) ??
    scheduledTaskDefaultModel(settings, project, instanceEntries);
  const activeInstanceId =
    modelSelection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = modelSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );
  const runtimeMode = sourceTask?.runtimeMode ?? settings.defaultRuntimeMode;
  const interactionMode = sourceTask?.interactionMode ?? "default";

  const updateFinding = useAtomCommand(serverEnvironment.updateFinding, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const environment = environments.find((entry) => entry.environmentId === environmentId) ?? null;
  const canStart =
    phase.kind !== "busy" &&
    environment !== null &&
    project !== null &&
    modelSelection !== null &&
    baseBranch.trim().length > 0;

  const start = async (mode: StartFindingWorkMode) => {
    if (!canStart || project === null || modelSelection === null) return;
    setPhase({ kind: "busy" });
    const createdAt = new Date().toISOString();
    const result = await startFindingWork(
      { findingId: row.finding.findingId, workEnvironmentId: environmentId, mode },
      {
        claim: async (claim) => {
          const claimed = await updateFinding({
            environmentId: row.environmentId,
            input: { findingId: row.finding.findingId, claim },
          });
          if (claimed._tag === "Success") return { ok: true };
          const error = squashAtomCommandFailure(claimed);
          return { ok: false, conflict: isClaimConflict(error), error };
        },
        launch: async (ids) => {
          const launched = await startTurn({
            environmentId,
            input: {
              threadId: ids.threadId,
              commandId: ids.commandId,
              createdAt,
              message: {
                messageId: ids.messageId,
                role: "user",
                text: findingWorkBrief(row.finding),
                attachments: [],
              },
              modelSelection,
              titleSeed: row.finding.title,
              runtimeMode,
              interactionMode,
              bootstrap: {
                createThread: {
                  projectId: project.id,
                  title: row.finding.title,
                  modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: baseBranch,
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch,
                  branch: findingWorkBranch(row.finding.title, ids.attempt),
                  requireWorktree: true,
                  ...(startFromOrigin ? { startFromOrigin: true } : {}),
                },
                runSetupScript: true,
              },
            },
          });
          return launched._tag === "Success"
            ? { ok: true }
            : { ok: false, error: squashAtomCommandFailure(launched) };
        },
      },
    );
    switch (result.kind) {
      case "launched":
        toastManager.add({
          type: "success",
          title: `Worker started on ${environment?.label ?? "the environment"}`,
          description: row.finding.title,
        });
        onClose();
        return;
      case "claimed_elsewhere":
        setPhase({ kind: "conflict" });
        return;
      case "claim_failed":
        setPhase({ kind: "error", message: describe(result.error), retry: mode });
        return;
      case "launch_failed":
        setPhase({
          kind: "error",
          message: describe(result.error),
          retry: { kind: "retry", attempt: result.ids.attempt },
        });
        return;
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && phase.kind !== "busy") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix on</DialogTitle>
          <DialogDescription>
            Starts a worker thread with this finding as its brief. It opens a pull request and stops
            there; you merge.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-environment`}>Environment</Label>
            <Select
              value={environmentId}
              onValueChange={(next) => {
                if (next !== null) {
                  setEnvironmentId(next);
                  setProjectChoice(null);
                  setModelChoice(null);
                }
              }}
              disabled={phase.kind === "busy"}
            >
              <SelectTrigger id={`${id}-environment`} size="sm">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                      className="size-4"
                    />
                    {environment?.label ?? "Choose an environment"}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((entry) => (
                  <SelectItem key={entry.environmentId} value={entry.environmentId}>
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                      className="size-4"
                    />
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-project`}>Project</Label>
            <Select
              value={project?.id ?? null}
              onValueChange={(next) => setProjectChoice(next)}
              disabled={phase.kind === "busy" || projects.length === 0}
            >
              <SelectTrigger id={`${id}-project`} size="sm">
                <SelectValue placeholder="No projects on this environment">
                  {project?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-base`}>Base branch</Label>
            <WorktreeBaseBranchPicker
              id={`${id}-base`}
              environmentId={environmentId}
              cwd={project?.workspaceRoot ?? null}
              value={baseBranch}
              onValueChange={setBaseBranch}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={setStartFromOrigin}
              disabled={phase.kind === "busy" || project === null}
            />
            <p className="text-xs text-muted-foreground">
              The worker gets its own worktree on a new branch from here.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-model`}>Model</Label>
            {instanceEntries.length === 0 ? (
              <p className="text-sm text-destructive" role="status">
                No provider is set up on {environment?.label ?? "this environment"}.
              </p>
            ) : (
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={phase.kind === "busy"}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setModelChoice(
                    sourceModel !== null &&
                      sourceModel.instanceId === instanceId &&
                      sourceModel.model === model
                      ? sourceModel
                      : { instanceId, model },
                  )
                }
              />
            )}
            <p className="text-xs text-muted-foreground">
              {runtimeMode.replace(/-/g, " ")}
              {sourceTask && modelSelection === sourceModel ? `, as ${sourceTask.title} runs` : ""}
            </p>
          </div>
          {phase.kind === "conflict" ? (
            <p className="text-sm text-destructive" role="status">
              Work on this finding was started elsewhere first. Close this and the row will show it.
            </p>
          ) : phase.kind === "error" ? (
            <p className="text-sm text-destructive" role="status">
              {phase.retry.kind === "retry"
                ? "The worker is claimed but did not start. "
                : "Could not claim the finding. "}
              {phase.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={phase.kind === "busy"}>
            {phase.kind === "conflict" ? "Close" : "Cancel"}
          </Button>
          {phase.kind === "conflict" ? null : (
            <Button
              disabled={!canStart}
              onClick={() => void start(phase.kind === "error" ? phase.retry : initialMode)}
            >
              {phase.kind === "busy"
                ? "Starting…"
                : phase.kind === "error"
                  ? "Try again"
                  : `Start on ${environment?.label ?? "environment"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
