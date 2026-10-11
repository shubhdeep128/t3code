import { useAtomValue } from "@effect/atom-react";
import {
  summarizeWatchers,
  type WatcherSummary,
  type WatcherSummaryInput,
} from "@t3tools/client-runtime/state/watcher-cards";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { PencilIcon, PlayIcon, PlusIcon, RadarIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  ScheduledTaskEditorDialog,
  relativeLabel,
  scheduleLabel,
} from "../settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { FiringStatusBadge } from "./findingPresentation";

const EVERY_SCOPE = {};
const noop = () => {};

function WatcherCard({
  summary,
  environment,
  onEdit,
  onRan,
}: {
  summary: WatcherSummary;
  environment: EnvironmentPresentation | null;
  onEdit: () => void;
  onRan: () => void;
}) {
  const { environmentId, task, lastFiring, openFindings, firingsInWeek } = summary;
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "watcher enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, { label: "watcher run now" });
  const [busy, setBusy] = useState(false);
  const isWebhook = task.schedule.type === "webhook";

  const act = async (action: "toggle" | "run") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : await run({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: action === "run" ? "Could not run the watcher" : "Could not update the watcher",
        description: String(squashAtomCommandFailure(result)),
      });
      return;
    }
    if (action === "run") onRan();
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">{task.title}</h3>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{scheduleLabel(task.schedule)}</span>
            <span aria-hidden>·</span>
            <EnvironmentMachineIcon
              kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
              className="size-3"
            />
            <span className="truncate">{environment?.label ?? "Unknown environment"}</span>
          </p>
        </div>
        <Switch
          size="sm"
          checked={task.enabled}
          disabled={busy || !canOperate}
          aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
          onCheckedChange={() => void act("toggle")}
        />
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {lastFiring === null ? (
          <span>Never ran</span>
        ) : (
          <>
            <FiringStatusBadge status={lastFiring.status} />
            <span>
              {lastFiring.skipped !== null && lastFiring.skippedCount > 1
                ? `${lastFiring.skippedCount} times, last `
                : ""}
              {formatRelativeTimeLabel(lastFiring.firedAt)}
            </span>
            {lastFiring.error ? (
              <span className="truncate text-destructive">{lastFiring.error}</span>
            ) : lastFiring.lastMessage ? (
              <span className="min-w-0 flex-1 truncate">· {lastFiring.lastMessage}</span>
            ) : null}
          </>
        )}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
          <dd className="text-base font-semibold tabular-nums text-foreground">{openFindings}</dd>
          <dt className="text-muted-foreground">open findings</dt>
        </div>
        <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
          <dd className="text-base font-semibold tabular-nums text-foreground">{firingsInWeek}</dd>
          <dt className="text-muted-foreground">runs this week</dt>
        </div>
      </dl>
      <div className="flex items-center gap-1.5">
        {isWebhook ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !canOperate}
            aria-label={`Run ${task.title} now`}
            onClick={() => void act("run")}
          >
            <PlayIcon />
            Run now
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canOperate}
          aria-label={`Edit ${task.title}`}
          onClick={onEdit}
        >
          <PencilIcon />
          Edit
        </Button>
        <span className="ms-auto truncate text-xs text-muted-foreground">
          {!task.enabled
            ? "Paused"
            : isWebhook
              ? "Listening"
              : task.nextRunAt
                ? `Next ${relativeLabel(task.nextRunAt)}`
                : "Not scheduled"}
        </span>
      </div>
    </li>
  );
}

/** One card per scheduled task across environments, with the controls Settings already has. */
export function WatcherCards({
  environments,
  tasks,
  firings,
  findings,
  loading,
  onRan,
}: WatcherSummaryInput & {
  environments: ReadonlyArray<EnvironmentPresentation>;
  loading: boolean;
  onRan: () => void;
}) {
  const nowMs = useRelativeTimeTick(60_000);
  const summaries = useMemo(
    () => summarizeWatchers({ tasks, firings, findings }, nowMs),
    [tasks, firings, findings, nowMs],
  );
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const defaultEnvironment = environments[0] ?? null;
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(defaultEnvironment?.environmentId ?? null),
  );
  const labelFor = new Map(environments.map((entry) => [entry.environmentId, entry]));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Each scheduled task is a watcher. Its findings land in Today.
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={defaultEnvironment === null || !canCreate}
          onClick={() =>
            defaultEnvironment &&
            setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
          }
        >
          <PlusIcon />
          New watcher
        </Button>
      </div>
      {summaries.length === 0 ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RadarIcon />
            </EmptyMedia>
            <EmptyTitle>{loading ? "Loading watchers…" : "No watchers yet"}</EmptyTitle>
            <EmptyDescription>
              A watcher is a scheduled task whose agent files what it finds. Create one here or in
              Settings.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {summaries.map((summary) => (
            <WatcherCard
              key={`${summary.environmentId}:${summary.task.id}`}
              summary={summary}
              environment={labelFor.get(summary.environmentId) ?? null}
              onEdit={() => setEditor({ environmentId: summary.environmentId, task: summary.task })}
              onRan={onRan}
            />
          ))}
        </ul>
      )}
      {editor ? (
        <SettingsScopeProvider search={EVERY_SCOPE} onChange={noop}>
          <ScheduledTaskEditorDialog
            key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
            initialEnvironmentId={editor.environmentId}
            task={editor.task}
            onClose={() => setEditor(null)}
          />
        </SettingsScopeProvider>
      ) : null}
    </div>
  );
}
