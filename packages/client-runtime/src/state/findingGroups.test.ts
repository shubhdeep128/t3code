import type { FindingProgress } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupFindings } from "./findingGroups.ts";

function item(
  title: string,
  environment: string,
  severity: "high" | "medium" | "low",
  lastSeenAt: string,
  progress: FindingProgress,
) {
  return { title, environment, finding: { severity, lastSeenAt }, progress };
}

const pr = {
  host: "github.com",
  repository: "oncourse/app",
  number: 1,
  url: "https://github.com/oncourse/app/pull/1",
  source: "created" as const,
  linkedAt: "2026-10-11T06:00:00.000Z",
  snapshot: null,
  stack: null,
};

describe("groupFindings", () => {
  it("merges two environments into the page's groups, by severity then newest", () => {
    const groups = groupFindings([
      item("bundle grew", "mini", "low", "2026-10-11T08:00:00Z", { kind: "new" }),
      item("rage taps", "mbp", "high", "2026-10-11T06:00:00Z", { kind: "new" }),
      item("reviews", "mini", "medium", "2026-10-11T07:00:00Z", { kind: "new" }),
      item("p2034", "mbp", "medium", "2026-10-11T09:00:00Z", { kind: "new" }),
      item("ipad sheet", "mbp", "medium", "2026-10-11T05:00:00Z", {
        kind: "needs_you",
        reason: "question",
      }),
      item("sync conflict", "mini", "medium", "2026-10-11T04:00:00Z", { kind: "detached" }),
      item("deck open", "mini", "high", "2026-10-10T06:00:00Z", { kind: "ready_to_merge", pr }),
      item("retry writes", "mbp", "high", "2026-10-11T10:00:00Z", {
        kind: "working",
        stalled: false,
      }),
      item("sheet component", "mini", "medium", "2026-10-09T10:00:00Z", {
        kind: "in_review",
        pr,
      }),
      item("elsewhere", "mini", "low", "2026-10-11T01:00:00Z", { kind: "unknown" }),
      item("selectors", "mini", "medium", "2026-10-11T11:40:00Z", { kind: "merged", pr }),
      item("cold start", "mbp", "high", "2026-10-06T00:00:00Z", { kind: "backlog" }),
      item("noisy 401s", "mini", "low", "2026-09-27T00:00:00Z", { kind: "dismissed" }),
    ]);

    expect(
      groups.map((group) => ({
        key: group.key,
        label: group.label,
        items: group.items.map((entry) => `${entry.title} @${entry.environment}`),
      })),
    ).toEqual([
      { key: "needs_you", label: "Needs you", items: ["ipad sheet @mbp", "sync conflict @mini"] },
      { key: "ready_to_merge", label: "Ready to merge", items: ["deck open @mini"] },
      {
        key: "new",
        label: "New",
        items: ["rage taps @mbp", "p2034 @mbp", "reviews @mini", "bundle grew @mini"],
      },
      {
        key: "in_progress",
        label: "In progress",
        items: ["retry writes @mbp", "sheet component @mini", "elsewhere @mini"],
      },
      { key: "merged", label: "Merged", items: ["selectors @mini"] },
      { key: "backlog", label: "Backlog", items: ["cold start @mbp"] },
      { key: "dismissed", label: "Dismissed", items: ["noisy 401s @mini"] },
    ]);
  });

  it("keeps every group in order when there is nothing to show", () => {
    expect(groupFindings([]).map((group) => [group.key, group.items.length])).toEqual([
      ["needs_you", 0],
      ["ready_to_merge", 0],
      ["new", 0],
      ["in_progress", 0],
      ["merged", 0],
      ["backlog", 0],
      ["dismissed", 0],
    ]);
  });
});
