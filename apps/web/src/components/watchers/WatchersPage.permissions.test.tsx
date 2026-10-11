// @vitest-environment jsdom
import {
  EnvironmentId,
  FindingId,
  ProjectId,
  ThreadId,
  type Finding,
  type FindingProgress,
  type OrchestrationV2ThreadShell,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  operate: true,
  write: true,
  update: vi.fn(),
  interrupt: vi.fn(),
  perform: vi.fn(),
  fixOn: vi.fn(),
  toast: vi.fn(),
  runnerOptions: null as null | {
    resolveMergeMethod?: (detail: PullRequestDetail) => string;
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "write" ? state.write : state.operate),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.operate,
  useEnvironmentScope: () => state.operate,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateFinding: { permissionAtom: () => "operate" } },
}));
vi.mock("../../state/pullRequests", () => ({
  pullRequestEnvironment: { runAction: { permissionAtom: () => "write" } },
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { interruptTurn: "interrupt" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "interrupt" ? state.interrupt : state.update),
}));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ pullRequestMergeMethod: "rebase" }) },
}));
vi.mock("../pullRequest/usePullRequestActions", () => ({
  usePullRequestActionRunner: (options: typeof state.runnerOptions) => {
    state.runnerOptions = options;
    return { actionPending: false, perform: state.perform };
  },
  usePullRequestDefaultMergeMethodResolver: () => () => "squash",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? children : null,
  AlertDialogPopup: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogClose: () => null,
}));

import { FindingActions } from "./FindingActions";

const mini = EnvironmentId.make("mini");
const mbp = EnvironmentId.make("mbp");
const findingId = FindingId.make("f1");
const workThreadId = ThreadId.make("finding-work:f1:1");
const onMbp = { environmentId: mbp, threadId: workThreadId };

const pr = {
  host: "github.com",
  repository: "oncourse/app",
  number: 7,
  url: "https://github.com/oncourse/app/pull/7",
  source: "created" as const,
  linkedAt: "2026-10-11T06:00:00.000Z",
  snapshot: {
    state: "open" as const,
    title: "Fix deck open",
    headBranch: "finding/deck-open",
    baseBranch: "dev",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-10-11T06:00:00.000Z",
  },
  stack: null,
};

function row(progress: FindingProgress, workThread: Finding["workThread"] = null) {
  const finding: Finding = {
    findingId,
    projectId: ProjectId.make("p1"),
    fingerprint: "perf:deck-open",
    title: "Deck open regressed",
    detail: "p75 went from 420 ms to 780 ms",
    severity: "high",
    source: { type: "thread", threadId: ThreadId.make("reporter") },
    triage: progress.kind === "backlog" || progress.kind === "dismissed" ? progress.kind : "open",
    workThread,
    workAttempt: workThread === null ? 0 : 1,
    workMergedAt: null,
    firstSeenAt: "2026-10-11T06:00:00.000Z",
    lastSeenAt: "2026-10-11T06:00:00.000Z",
    seenCount: 1,
  };
  return {
    key: `${mini}:${findingId}`,
    environmentId: mini,
    environmentLabel: "Mac mini",
    finding,
    progress,
    work:
      workThread === null
        ? null
        : ({ projectId: ProjectId.make("p1-on-mbp") } as OrchestrationV2ThreadShell),
  };
}

let renderer: ReactTestRenderer;
beforeEach(() => {
  state.operate = true;
  state.write = true;
  state.update.mockReset().mockResolvedValue({ _tag: "Success" });
  state.interrupt.mockReset().mockResolvedValue({ _tag: "Success" });
  state.perform.mockReset().mockResolvedValue(true);
  state.fixOn.mockReset();
  state.toast.mockReset();
  state.runnerOptions = null;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

async function render(element: React.ReactElement) {
  await act(async () => {
    renderer = create(element);
  });
}

function button(label: string) {
  return renderer.root.findAllByProps({ "aria-label": label })[0]!;
}

async function click(label: string) {
  const target = button(label);
  await act(async () => {
    await target.props.onClick();
  });
}

it("merges with the repository's method after a second press, only with source-control write", async () => {
  await render(
    <FindingActions row={row({ kind: "ready_to_merge", pr }, onMbp)} onFixOn={state.fixOn} />,
  );
  expect(button("Merge").props.disabled).toBe(false);
  await click("Merge");
  expect(state.perform).not.toHaveBeenCalled();
  expect(button("Merge").props.children[0]).toBe("Confirm merge?");
  await click("Merge");
  expect(state.perform.mock.calls).toEqual([["merge"]]);
  expect(
    state.runnerOptions?.resolveMergeMethod?.({
      capabilities: { mergeMethods: ["merge", "squash", "rebase"] },
      mergeCapabilities: { merge: true, squash: true, rebase: true },
    } as unknown as PullRequestDetail),
  ).toBe("squash");

  state.write = false;
  await act(async () => {
    renderer.update(
      <FindingActions row={row({ kind: "ready_to_merge", pr }, onMbp)} onFixOn={state.fixOn} />,
    );
  });
  expect(button("Merge").props.disabled).toBe(true);
  expect(button("Dismiss").props.disabled).toBe(false);
  await click("Merge");
  expect(state.perform.mock.calls).toEqual([["merge"]]);
});

it("fixes, backlogs and dismisses only with orchestration operate, which merge does not need", async () => {
  await render(<FindingActions row={row({ kind: "new" })} onFixOn={state.fixOn} />);
  await click("Fix on");
  await click("Backlog");
  await click("Dismiss");
  expect(state.fixOn.mock.calls).toEqual([[{ kind: "claim", expectedWorkAttempt: 0 }]]);
  expect(state.update.mock.calls).toEqual([
    [{ environmentId: mini, input: { findingId, triage: "backlog" } }],
    [{ environmentId: mini, input: { findingId, triage: "dismissed" } }],
  ]);

  state.operate = false;
  state.update.mockClear();
  state.fixOn.mockClear();
  await act(async () => {
    renderer.update(<FindingActions row={row({ kind: "new" })} onFixOn={state.fixOn} />);
  });
  for (const label of ["Fix on", "Backlog", "Dismiss"]) {
    expect(button(label).props.disabled).toBe(true);
    await click(label);
  }
  expect(state.fixOn).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();

  await act(async () => {
    renderer.update(
      <FindingActions row={row({ kind: "ready_to_merge", pr }, onMbp)} onFixOn={state.fixOn} />,
    );
  });
  expect(button("Merge").props.disabled).toBe(false);
});

it("dismissing a running worker asks first, then stops it, closes its pull request and dismisses", async () => {
  await render(
    <FindingActions row={row({ kind: "in_review", pr }, onMbp)} onFixOn={state.fixOn} />,
  );
  await click("Dismiss");
  expect(state.update).not.toHaveBeenCalled();
  const stop = renderer.root
    .findAllByType("button")
    .find((node) => node.props.children === "Stop the worker and dismiss")!;
  await act(async () => {
    await stop.props.onClick();
  });
  expect(state.interrupt.mock.calls).toEqual([
    [{ environmentId: mbp, input: { threadId: workThreadId } }],
  ]);
  expect(state.perform.mock.calls).toEqual([["close"]]);
  expect(state.update.mock.calls).toEqual([
    [{ environmentId: mini, input: { findingId, triage: "dismissed" } }],
  ]);
});

it("writes nothing when the worker cannot be stopped", async () => {
  state.interrupt.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
  await render(
    <FindingActions row={row({ kind: "in_review", pr }, onMbp)} onFixOn={state.fixOn} />,
  );
  await click("Dismiss");
  const stop = renderer.root
    .findAllByType("button")
    .find((node) => node.props.children === "Stop the worker and dismiss")!;
  await act(async () => {
    await stop.props.onClick();
  });
  expect(state.perform).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(state.toast.mock.calls).toEqual([
    [{ type: "error", title: "Could not stop the worker", description: "offline" }],
  ]);
});

it("stop work interrupts the worker and detaches it with the current attempt", async () => {
  await render(
    <FindingActions row={row({ kind: "working", stalled: true }, onMbp)} onFixOn={state.fixOn} />,
  );
  await click("Stop work");
  expect(state.interrupt.mock.calls).toEqual([
    [{ environmentId: mbp, input: { threadId: workThreadId } }],
  ]);
  expect(state.update.mock.calls).toEqual([
    [
      {
        environmentId: mini,
        input: { findingId, claim: { workThread: null, expectedWorkAttempt: 1 } },
      },
    ],
  ]);
});
