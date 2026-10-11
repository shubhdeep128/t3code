import type { EnvironmentId, FindingSource } from "@t3tools/contracts";

/**
 * What a row says about where a finding came from: the watcher's title, or
 * nothing. A thread source and a watcher whose title is not loaded both read
 * as nothing, since the detail pane names them.
 */
export function findingSourceLabel(
  source: FindingSource,
  environmentId: EnvironmentId,
  taskTitles: ReadonlyMap<string, string>,
): string | null {
  if (source.type !== "scheduled_task") return null;
  return taskTitles.get(`${environmentId}:${source.taskId}`) ?? null;
}
