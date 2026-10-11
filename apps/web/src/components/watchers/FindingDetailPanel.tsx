import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  PullRequestRef,
  ScheduledTask,
  ScheduledTaskFiringView,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import type { WatcherFindingRow } from "../../state/watchers";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PullRequestChecksPopover } from "../pullRequest/PullRequestChecksPopover";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  FindingActions,
  pullRequestReference,
  workerPullRequest,
  type RunFindingAction,
} from "./FindingActions";
import { FiringStatusBadge, ProgressBadge, SeverityBadge } from "./findingPresentation";
import type { StartFindingWorkMode } from "./fixOn.logic";

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 p-4">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

const KEYS: ReadonlyArray<[keys: string[], does: string]> = [
  [["j", "k"], "move"],
  [["Enter"], "open"],
  [["f"], "fix on"],
  [["m"], "merge"],
  [["b"], "backlog"],
  [["d"], "dismiss"],
  [["Esc"], "back"],
];

export function FindingDetailPanel({
  row,
  project,
  sourceTask,
  sourceFiring,
  environmentLabelFor,
  showEnvironment,
  onRunReady,
  onFixOn,
  onClose,
}: {
  row: WatcherFindingRow;
  project: EnvironmentProject | null;
  sourceTask: ScheduledTask | null;
  sourceFiring: ScheduledTaskFiringView | null;
  environmentLabelFor: (environmentId: EnvironmentId) => string;
  /** Environment names are noise with one machine connected. */
  showEnvironment: boolean;
  /** Hands the page the action runner, so letter keys share the buttons' path. */
  onRunReady: (run: RunFindingAction | null) => void;
  onFixOn: (mode: StartFindingWorkMode) => void;
  onClose: () => void;
}) {
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const pr = workerPullRequest(row);
  const reference = pullRequestReference(row);
  const workThread = row.finding.workThread;
  const workEnvironmentId = workThread?.environmentId ?? null;
  // Settled worker threads stop syncing their pull request, so opening the
  // finding asks the host again. Keyed on the link rather than the row, so a
  // shell update while the panel is open does not ask twice.
  const referenceKey = reference === null ? null : JSON.stringify(reference);
  useEffect(() => {
    if (referenceKey === null || workEnvironmentId === null) return;
    void invalidate({
      environmentId: workEnvironmentId,
      input: { reference: JSON.parse(referenceKey) as PullRequestRef },
    });
  }, [invalidate, referenceKey, workEnvironmentId]);

  const source = row.finding.source;
  return (
    <article className="flex min-w-0 flex-col gap-4" aria-label={row.finding.title}>
      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <SeverityBadge severity={row.finding.severity} />
            <ProgressBadge progress={row.progress} />
            <span>{project?.title ?? "Unknown project"}</span>
            {showEnvironment ? (
              <>
                <span aria-hidden>·</span>
                <span>{row.environmentLabel}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>
              first seen {formatRelativeTimeLabel(row.finding.firstSeenAt)}
              {row.finding.seenCount > 1 ? `, seen ${row.finding.seenCount}×` : ""}
            </span>
          </div>
          <Button size="icon-xs" variant="ghost" aria-label="Close finding" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <h2 className="text-lg font-semibold leading-snug text-foreground">{row.finding.title}</h2>
        <FindingActions row={row} onRunReady={onRunReady} onFixOn={onFixOn} />
      </header>

      <DetailSection title="Evidence">
        {project === null ? (
          <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/90">
            {row.finding.detail}
          </pre>
        ) : (
          <PullRequestMarkdown
            text={row.finding.detail}
            cwd={project.workspaceRoot}
            environmentId={row.environmentId}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Fingerprint <code className="font-mono">{row.finding.fingerprint}</code>
        </p>
      </DetailSection>

      <DetailSection title="From finding to merge">
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Found by</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {source.type === "scheduled_task" ? (
              <>
                <span className="truncate">{sourceTask?.title ?? "A deleted watcher"}</span>
                {sourceFiring !== null ? (
                  <>
                    <FiringStatusBadge status={sourceFiring.status} />
                    <span className="text-muted-foreground">
                      last ran {formatRelativeTimeLabel(sourceFiring.firedAt)}
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: row.environmentId, threadId: source.threadId }}
                className="truncate underline-offset-2 hover:underline"
              >
                {showEnvironment ? `A thread on ${row.environmentLabel}` : "A thread"}
              </Link>
            )}
          </dd>
          <dt className="text-muted-foreground">Worker</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {workThread === null ? (
              <span className="text-muted-foreground">Nobody yet</span>
            ) : row.work === null ? (
              <span className="text-muted-foreground">
                Thread on {environmentLabelFor(workThread.environmentId)}
                {row.finding.workAttempt > 1 ? `, attempt ${row.finding.workAttempt}` : ""}
              </span>
            ) : (
              <>
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: workThread.environmentId,
                    threadId: workThread.threadId,
                  }}
                  className="truncate underline-offset-2 hover:underline"
                >
                  {row.work.title || "Untitled thread"}
                </Link>
                <span className="text-muted-foreground">
                  {[
                    showEnvironment || workThread.environmentId !== row.environmentId
                      ? `on ${environmentLabelFor(workThread.environmentId)}`
                      : null,
                    row.work.branch,
                    row.finding.workAttempt > 1 ? `attempt ${row.finding.workAttempt}` : null,
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
                </span>
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">Pull request</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {pr === null ? (
              <span className="text-muted-foreground">
                {row.finding.workMergedAt !== null
                  ? `Merged ${formatRelativeTimeLabel(row.finding.workMergedAt)}`
                  : "None yet"}
              </span>
            ) : (
              <>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 truncate underline-offset-2 hover:underline"
                >
                  {pr.repository}#{pr.number}
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </a>
                {pr.snapshot ? (
                  <>
                    <span className="truncate text-muted-foreground">{pr.snapshot.title}</span>
                    {pr.snapshot.checksState != null &&
                    workEnvironmentId !== null &&
                    reference !== null ? (
                      <PullRequestChecksPopover
                        checksState={pr.snapshot.checksState}
                        environmentId={workEnvironmentId}
                        reference={reference}
                        variant="count"
                      />
                    ) : null}
                    {pr.snapshot.reviewDecision ? (
                      <span className="text-muted-foreground">
                        {pr.snapshot.reviewDecision.replace(/-/g, " ")}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </dd>
        </dl>
      </DetailSection>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {KEYS.map(([keys, does]) => (
          <span key={does} className="inline-flex items-center gap-1">
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
            {does}
          </span>
        ))}
      </p>
    </article>
  );
}
