import {
  type FindingClaimConflict,
  type FindingError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FindingService from "../../../watchers/FindingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { WatchersToolkit } from "./tools.ts";

const failure = (error: FindingError | FindingClaimConflict) =>
  new OrchestratorMcpFailure({
    code: error._tag === "FindingClaimConflict" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(WatchersToolkit, {
  report_finding: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { thread } = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "report_finding")),
      );
      const findings = yield* FindingService.FindingService;
      return yield* findings
        .report({ ...input, threadId: thread.threadId })
        .pipe(Effect.mapError(failure));
    }),
  ),
  list_findings: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const findings = yield* FindingService.FindingService;
      return yield* findings.list(input).pipe(Effect.mapError(failure));
    }),
  ),
  update_finding: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const findings = yield* FindingService.FindingService;
      return yield* findings.update(input).pipe(Effect.mapError(failure));
    }),
  ),
});
