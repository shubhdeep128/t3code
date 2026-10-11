import { EnvironmentId, FindingId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findingWorkBranch, findingWorkIds, startFindingWork } from "./fixOn.logic";

const findingId = FindingId.make("f1");
const mbp = EnvironmentId.make("mbp");

function recorder(outcomes: { claim?: boolean | "conflict"; launch?: boolean } = {}) {
  const calls: Array<["claim" | "launch", unknown]> = [];
  return {
    calls,
    io: {
      claim: async (claim: unknown) => {
        calls.push(["claim", claim]);
        if (outcomes.claim === "conflict") {
          return { ok: false as const, conflict: true, error: new Error("conflict") };
        }
        if (outcomes.claim === false) {
          return { ok: false as const, conflict: false, error: new Error("offline") };
        }
        return { ok: true as const };
      },
      launch: async (ids: unknown) => {
        calls.push(["launch", ids]);
        return outcomes.launch === false
          ? { ok: false as const, error: new Error("no model") }
          : { ok: true as const };
      },
    },
  };
}

const ids1 = {
  attempt: 1,
  threadId: "finding-work:f1:1",
  messageId: "finding-work:f1:1:brief",
  commandId: "finding-work:f1:1:start",
};

describe("startFindingWork", () => {
  it("claims the next attempt with the thread id it will launch, then launches it", async () => {
    const { calls, io } = recorder();
    const result = await startFindingWork(
      { findingId, workEnvironmentId: mbp, mode: { kind: "claim", expectedWorkAttempt: 0 } },
      io,
    );
    expect(calls).toEqual([
      [
        "claim",
        {
          workThread: { environmentId: "mbp", threadId: "finding-work:f1:1" },
          expectedWorkAttempt: 0,
        },
      ],
      ["launch", ids1],
    ]);
    expect(result).toEqual({ kind: "launched", ids: ids1 });
  });

  it("never launches when another client claimed first", async () => {
    const { calls, io } = recorder({ claim: "conflict" });
    const result = await startFindingWork(
      { findingId, workEnvironmentId: mbp, mode: { kind: "claim", expectedWorkAttempt: 2 } },
      io,
    );
    expect(calls.map(([name]) => name)).toEqual(["claim"]);
    expect(result).toEqual({ kind: "claimed_elsewhere" });
  });

  it("reports a failed launch with the ids a retry must reuse", async () => {
    const { io } = recorder({ launch: false });
    const result = await startFindingWork(
      { findingId, workEnvironmentId: mbp, mode: { kind: "claim", expectedWorkAttempt: 0 } },
      io,
    );
    expect(result).toEqual({ kind: "launch_failed", ids: ids1, error: new Error("no model") });
  });

  it("retries the same thread without claiming again", async () => {
    const { calls, io } = recorder();
    const result = await startFindingWork(
      { findingId, workEnvironmentId: mbp, mode: { kind: "retry", attempt: 3 } },
      io,
    );
    expect(calls).toEqual([
      [
        "launch",
        {
          attempt: 3,
          threadId: "finding-work:f1:3",
          messageId: "finding-work:f1:3:brief",
          commandId: "finding-work:f1:3:start",
        },
      ],
    ]);
    expect(result.kind).toBe("launched");
  });
});

describe("findingWorkBranch", () => {
  it("slugs the title and numbers later attempts", () => {
    expect(findingWorkBranch("Deck open p75 regressed 420 ms → 780 ms in 2.31.0", 1)).toBe(
      "finding/deck-open-p75-regressed-420-ms-780-ms-in-2-31-0",
    );
    expect(findingWorkBranch("Rage taps on Welcome “Continue”", 2)).toBe(
      "finding/rage-taps-on-welcome-continue-2",
    );
    expect(findingWorkBranch("???", 1)).toBe("finding/finding");
  });
});

describe("findingWorkIds", () => {
  it("derives every id from the finding and attempt", () => {
    expect(findingWorkIds(findingId, 1)).toEqual(ids1);
  });
});
