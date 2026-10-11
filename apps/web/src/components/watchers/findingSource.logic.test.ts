import { EnvironmentId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findingSourceLabel } from "./findingSource.logic";

const mini = EnvironmentId.make("mini");
const mbp = EnvironmentId.make("mbp");
const perf = ScheduledTaskId.make("perf");
const titles = new Map([[`${mini}:${perf}`, "Perf watcher"]]);

describe("findingSourceLabel", () => {
  it("names the watcher on its own environment and nothing otherwise", () => {
    const fromWatcher = { type: "scheduled_task" as const, taskId: perf, fireKey: "k" };
    expect(findingSourceLabel(fromWatcher, mini, titles)).toBe("Perf watcher");
    expect(findingSourceLabel(fromWatcher, mbp, titles)).toBeNull();
    expect(
      findingSourceLabel({ type: "thread", threadId: ThreadId.make("t") }, mini, titles),
    ).toBeNull();
  });
});
