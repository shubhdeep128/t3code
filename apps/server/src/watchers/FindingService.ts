/**
 * The findings ledger: problems watchers noticed, collapsed by fingerprint so
 * agents on one machine never file the same problem twice.
 *
 * The table is created here, at service start, not in a numbered migration:
 * the migrator skips any number at or below the highest applied, so a fork
 * migration would swallow upstream's next one.
 *
 * @module watchers/FindingService
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  Finding,
  FindingClaimConflict,
  FindingError,
  FindingId,
  FindingSource,
  type FindingSeverity,
  type FindingsListInput,
  type FindingsListResult,
  type FindingsUpdateInput,
  type FindingsUpdateResult,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RunId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskFirings from "../scheduledTasks/ScheduledTaskFirings.ts";

const RECENT_DAYS = 14;
const LIST_LIMIT = 500;

/** The pull request the worker opened from its own branch, else the newest one it linked itself. */
const workerPullRequest = (
  shell: OrchestrationV2ThreadShell,
): ThreadPullRequestLink | undefined => {
  const links = visibleThreadPullRequests(shell.pullRequests ?? []);
  return (
    links.find((link) => shell.branch !== null && link.snapshot?.headBranch === shell.branch) ??
    links
      .filter((link) => link.source !== "stack")
      .toSorted((left, right) => right.linkedAt.localeCompare(left.linkedAt))[0]
  );
};

export class FindingService extends Context.Service<
  FindingService,
  {
    /**
     * Files a finding, or returns the one already filed for its fingerprint
     * with `created` false and its last sighting bumped. A finding whose work
     * merged is not matched, so the problem coming back opens a new one.
     */
    readonly report: (input: {
      /** The thread filing the finding, which its source is derived from. */
      readonly threadId: ThreadId;
      /** The reporting thread's project when omitted. */
      readonly projectId?: ProjectId | undefined;
      readonly fingerprint: string;
      readonly title: string;
      readonly detail: string;
      readonly severity: FindingSeverity;
    }) => Effect.Effect<{ readonly finding: Finding; readonly created: boolean }, FindingError>;
    /** Newest sighting first, at most 500. */
    readonly list: (input: FindingsListInput) => Effect.Effect<FindingsListResult, FindingError>;
    /**
     * Open findings whose work has not merged, and any seen in the last 14
     * days, then the same again after every change.
     */
    readonly subscribeList: () => Stream.Stream<FindingsListResult, FindingError>;
    readonly update: (
      input: FindingsUpdateInput,
    ) => Effect.Effect<FindingsUpdateResult, FindingError | FindingClaimConflict>;
  }
>()("t3/watchers/FindingService") {}

interface FindingRow {
  readonly finding_id: string;
  readonly project_id: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: string;
  readonly source_json: string;
  readonly triage: string;
  readonly work_environment_id: string | null;
  readonly work_thread_id: string | null;
  readonly work_attempt: number;
  readonly work_merged_at: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly seen_count: number;
}

const SourceJson = Schema.fromJsonString(FindingSource);
const encodeSource = Schema.encodeEffect(SourceJson);
const decodeFinding = Schema.decodeUnknownEffect(
  Schema.Struct({ ...Finding.fields, source: SourceJson }),
);
const fromRow = (row: FindingRow) =>
  decodeFinding({
    findingId: row.finding_id,
    projectId: row.project_id,
    fingerprint: row.fingerprint,
    title: row.title,
    detail: row.detail,
    severity: row.severity,
    source: row.source_json,
    triage: row.triage,
    workThread:
      row.work_thread_id === null
        ? null
        : { environmentId: row.work_environment_id, threadId: row.work_thread_id },
    workAttempt: row.work_attempt,
    workMergedAt: row.work_merged_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
  });

const isFindingError = Schema.is(FindingError);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** Stored times are UTC ISO strings, so an input time is normalized to one before it is compared or stored. */
const utcIso = (value: string | undefined, field: "since" | "workMergedAt") =>
  value === undefined
    ? Effect.succeed(undefined)
    : Option.match(DateTime.make(value), {
        onNone: () =>
          Effect.fail(new FindingError({ message: `${field} is not a date and time.` })),
        onSome: (time) => Effect.succeed(DateTime.formatIso(time)),
      });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const firings = yield* ScheduledTaskFirings.make;
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const oneReportAtATime = yield* Semaphore.make(1);

  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_watcher_findings (
      finding_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      severity TEXT NOT NULL,
      source_json TEXT NOT NULL,
      triage TEXT NOT NULL,
      work_environment_id TEXT,
      work_thread_id TEXT,
      work_attempt INTEGER NOT NULL,
      work_merged_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_watcher_findings_project_fingerprint
    ON fork_watcher_findings (project_id, fingerprint)
  `;

  /**
   * When the finding's work merged, or null. Work in another environment
   * counts as merged only once a client that can see it records `workMergedAt`.
   */
  const workMergedAt = Effect.fn("FindingService.workMergedAt")(function* (
    finding: Finding,
    now: string,
  ) {
    if (finding.workMergedAt !== null) return finding.workMergedAt;
    const work = finding.workThread;
    if (work === null || work.environmentId !== (yield* environment.getEnvironmentId)) {
      return null;
    }
    const shell = yield* threads.getThreadShell(work.threadId);
    const own = shell === null ? undefined : workerPullRequest(shell);
    return own?.snapshot?.state === "merged" ? (own.snapshot.mergedAt ?? now) : null;
  });

  const runBeforeRestartContinuations = Effect.fn("FindingService.runBeforeRestartContinuations")(
    function* (threadId: ThreadId, runId: RunId) {
      const readRun = (id: RunId) =>
        threads
          .getThreadRecords(threadId, ["runs"], { runIds: [id] })
          .pipe(Effect.map(({ runs }) => runs[0]));
      let run = yield* readRun(runId);
      while (run?.restartContinuationOfRunId !== undefined) {
        const continued = yield* readRun(run.restartContinuationOfRunId);
        if (continued === undefined || continued.ordinal >= run.ordinal) break;
        run = continued;
      }
      return run;
    },
  );

  /** The scheduled task firing whose message started the reporter's run, else the reporter itself. */
  const sourceOf = Effect.fn("FindingService.sourceOf")(function* (
    reporter: OrchestrationV2ThreadShell,
  ) {
    const fallback: FindingSource = { type: "thread", threadId: reporter.id };
    if (reporter.activeRunId === null) return fallback;
    const run = yield* runBeforeRestartContinuations(reporter.id, reporter.activeRunId);
    if (run === undefined) return fallback;
    const firing = yield* firings.firingForMessage(run.userMessageId);
    return firing === undefined
      ? fallback
      : ({
          type: "scheduled_task",
          taskId: firing.taskId,
          fireKey: firing.fireKey,
        } satisfies FindingSource);
  });

  const reportUnderLock = Effect.fn("FindingService.report")(function* (
    input: Parameters<FindingService["Service"]["report"]>[0],
  ) {
    const reporter = yield* threads.getThreadShell(input.threadId);
    if (reporter === null) {
      return yield* new FindingError({ message: "The reporting thread was not found." });
    }
    if (input.projectId !== undefined && Option.isNone(yield* projects.getShell(input.projectId))) {
      return yield* new FindingError({ message: "The project was not found." });
    }
    const projectId = input.projectId ?? reporter.projectId;
    const now = yield* nowIso;
    const [newestRow] = yield* sql<FindingRow>`
      SELECT * FROM fork_watcher_findings
      WHERE project_id = ${projectId} AND fingerprint = ${input.fingerprint}
      ORDER BY rowid DESC
      LIMIT 1
    `;
    const previous = newestRow === undefined ? undefined : yield* fromRow(newestRow);
    const previousMergedAt = previous === undefined ? null : yield* workMergedAt(previous, now);
    if (previous !== undefined && previousMergedAt === null) {
      const [seenRow] = yield* sql<FindingRow>`
        UPDATE fork_watcher_findings
        SET last_seen_at = ${now}, seen_count = seen_count + 1
        WHERE finding_id = ${previous.findingId}
        RETURNING *
      `;
      if (seenRow === undefined) {
        return yield* new FindingError({
          message: "The finding was not found.",
          findingId: previous.findingId,
        });
      }
      return { finding: yield* fromRow(seenRow), created: false };
    }
    if (previous !== undefined && previous.workMergedAt === null) {
      yield* sql`
        UPDATE fork_watcher_findings
        SET work_merged_at = COALESCE(work_merged_at, ${previousMergedAt})
        WHERE finding_id = ${previous.findingId}
      `;
    }

    const finding: Finding = {
      findingId: FindingId.make(`finding:${yield* crypto.randomUUIDv4}`),
      projectId,
      fingerprint: input.fingerprint,
      title: input.title,
      detail:
        previous === undefined
          ? input.detail
          : `${input.detail}\n\nPrevious finding, whose fix merged: ${previous.findingId}`,
      severity: input.severity,
      source: yield* sourceOf(reporter),
      triage: "open",
      workThread: null,
      workAttempt: 0,
      workMergedAt: null,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    };
    yield* sql`
      INSERT INTO fork_watcher_findings (
        finding_id, project_id, fingerprint, title, detail, severity, source_json, triage,
        work_environment_id, work_thread_id, work_attempt, work_merged_at,
        first_seen_at, last_seen_at, seen_count
      )
      VALUES (
        ${finding.findingId}, ${finding.projectId}, ${finding.fingerprint}, ${finding.title},
        ${finding.detail}, ${finding.severity}, ${yield* encodeSource(finding.source)}, ${finding.triage},
        NULL, NULL, 0, NULL, ${now}, ${now}, 1
      )
    `;
    return { finding, created: true };
  });

  const report: FindingService["Service"]["report"] = (input) =>
    oneReportAtATime
      .withPermits(1)(reportUnderLock(input))
      .pipe(
        Effect.tap(() => notifyChanged),
        Effect.mapError((cause) =>
          isFindingError(cause)
            ? cause
            : new FindingError({ message: "Could not report the finding.", cause }),
        ),
      );

  const list: FindingService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const since = yield* utcIso(input.since, "since");
      const rows = yield* sql<FindingRow>`
        SELECT * FROM fork_watcher_findings
        WHERE ${sql.and([
          ...(input.projectId === undefined ? [] : [sql`project_id = ${input.projectId}`]),
          ...(input.triage === undefined ? [] : [sql`triage = ${input.triage}`]),
          ...(since === undefined ? [] : [sql`last_seen_at >= ${since}`]),
          ...(input.query === undefined
            ? []
            : [
                sql`instr(lower(title || ' ' || detail || ' ' || fingerprint), lower(${input.query})) > 0`,
              ]),
        ])}
        ORDER BY last_seen_at DESC, rowid DESC
        LIMIT ${input.limit ?? LIST_LIMIT}
      `.pipe(
        Effect.mapError(
          (cause) => new FindingError({ message: "Could not list findings.", cause }),
        ),
      );
      return {
        findings: yield* Effect.forEach(rows, fromRow).pipe(
          Effect.mapError(
            (cause) => new FindingError({ message: "Could not read a stored finding.", cause }),
          ),
        ),
      };
    });

  const openOrRecent = Effect.gen(function* () {
    const cutoff = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: RECENT_DAYS }),
    );
    const rows = yield* sql<FindingRow>`
      SELECT * FROM fork_watcher_findings
      WHERE (triage = 'open' AND work_merged_at IS NULL) OR last_seen_at >= ${cutoff}
      ORDER BY last_seen_at DESC, rowid DESC
    `;
    return { findings: yield* Effect.forEach(rows, fromRow) };
  }).pipe(
    Effect.mapError((cause) => new FindingError({ message: "Could not list findings.", cause })),
  );

  const subscribeList: FindingService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changesFromBeforeFirstRead = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(openOrRecent),
          Stream.fromSubscription(changesFromBeforeFirstRead).pipe(
            Stream.mapEffect(() => openOrRecent),
          ),
        );
      }),
    );

  const update: FindingService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const { findingId, claim } = input;
      const mergedAt = yield* utcIso(input.workMergedAt, "workMergedAt");
      const assignments = [
        ...(input.triage === undefined ? [] : [sql`triage = ${input.triage}`]),
        ...(claim === undefined
          ? []
          : [
              sql`work_environment_id = ${claim.workThread?.environmentId ?? null}`,
              sql`work_thread_id = ${claim.workThread?.threadId ?? null}`,
              sql`work_attempt = work_attempt + 1`,
              sql`work_merged_at = ${mergedAt ?? null}`,
            ]),
        ...(claim !== undefined || mergedAt === undefined
          ? []
          : [sql`work_merged_at = COALESCE(work_merged_at, ${mergedAt})`]),
      ];
      const storageError = (cause: unknown) =>
        new FindingError({ message: "Could not update the finding.", findingId, cause });
      const [row] = yield* (
        assignments.length === 0
          ? sql<FindingRow>`SELECT * FROM fork_watcher_findings WHERE finding_id = ${findingId}`
          : sql<FindingRow>`
              UPDATE fork_watcher_findings
              ${sql.csv("SET", assignments)}
              WHERE finding_id = ${findingId}
                ${claim === undefined ? sql`` : sql`AND work_attempt = ${claim.expectedWorkAttempt}`}
              RETURNING *
            `
      ).pipe(Effect.mapError(storageError));
      if (row !== undefined) {
        const finding = yield* fromRow(row).pipe(Effect.mapError(storageError));
        if (assignments.length > 0) yield* notifyChanged;
        return { finding };
      }
      const [current] = yield* sql<{ readonly work_attempt: number }>`
        SELECT work_attempt FROM fork_watcher_findings WHERE finding_id = ${findingId}
      `.pipe(Effect.mapError(storageError));
      if (current === undefined || claim === undefined) {
        return yield* new FindingError({ message: "The finding was not found.", findingId });
      }
      return yield* new FindingClaimConflict({
        findingId,
        expectedWorkAttempt: claim.expectedWorkAttempt,
        workAttempt: current.work_attempt,
      });
    });

  return FindingService.of({ report, list, subscribeList, update });
});

export const layer = Layer.effect(FindingService, make);
