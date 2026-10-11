import {
  Finding,
  FindingSeverity,
  FindingView,
  FindingsListInput,
  FindingsUpdateInput,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as FindingService from "../../../watchers/FindingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FindingService.FindingService,
  ],
};

const ReportFindingTool = Tool.make("report_finding", {
  ...shared,
  description:
    "Needs an agent running inside a T3 thread. File a problem you found so the user can triage it and other watchers do not file it again. Call list_findings for the project first. A report with the fingerprint of a finding already filed returns that finding with created=false, its triage, its work thread and its progress (see list_findings), and counts the sighting; send new evidence to a live work thread with t3_thread_send instead of filing again. A dismissed finding stays dismissed. A finding whose fix already merged is filed again as a new one. The source is recorded from this thread, or from the scheduled task firing that started its run.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({ description: "Project the problem is in. Omit for this thread's." }),
    ),
    fingerprint: TrimmedNonEmptyString.annotate({
      description:
        "A key that stays the same every time this exact problem is seen, such as the error class and where it happens. Never include a time, run id or count.",
    }),
    title: TrimmedNonEmptyString.annotate({ description: "One line naming the problem." }),
    detail: Schema.String.check(Schema.isMaxLength(20_000)).annotate({
      description:
        "Markdown evidence: what you saw, where, and how to reproduce it. At most 20,000 characters.",
    }),
    severity: FindingSeverity,
  }),
  success: Schema.Struct({ finding: FindingView, created: Schema.Boolean }),
})
  .annotate(Tool.Title, "Report a finding")
  .annotate(Tool.Destructive, false);

const ListFindingsTool = Tool.make("list_findings", {
  ...shared,
  description:
    "List findings in this environment, most recently seen first. Omit projectId for every project. since keeps findings last seen at or after an ISO time, triage keeps one decision (open, backlog, dismissed), query matches the title, detail or fingerprint, and limit caps the count (500 when omitted). Each finding has progress.kind: new (no work thread), working (stalled=true after 30 minutes without activity, or when the worker stopped without an open pull request), needs_you (reason question or failed), in_review, ready_to_merge (open, checks passing or none configured, approved or no review required, mergeable), merged, detached (work thread archived or deleted), unknown (work thread on another machine), backlog or dismissed.",
  parameters: FindingsListInput,
  success: Schema.Struct({ findings: Schema.Array(FindingView) }),
})
  .annotate(Tool.Title, "List findings")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateFindingTool = Tool.make("update_finding", {
  ...shared,
  description:
    "Change a finding's triage, or claim it for a work thread. A claim sets workThread, or detaches it with null, only while the finding's workAttempt still equals expectedWorkAttempt; read it from list_findings. A claim that lost to another changes nothing and fails.",
  parameters: Schema.Struct({
    findingId: FindingsUpdateInput.fields.findingId,
    triage: FindingsUpdateInput.fields.triage,
    claim: FindingsUpdateInput.fields.claim,
  }),
  success: Schema.Struct({ finding: Finding }),
})
  .annotate(Tool.Title, "Update a finding")
  .annotate(Tool.Destructive, true);

export const WatchersToolkit = Toolkit.make(ReportFindingTool, ListFindingsTool, UpdateFindingTool);
