import {
  EnvironmentId,
  FindingId,
  ProjectId,
  ThreadId,
  type Finding,
  type FindingProgress,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  operate: true,
  write: true,
  update: vi.fn(),
  interrupt: vi.fn(),
  perform: vi.fn(),
  fixOn: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "write" ? state.write : state.operate),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => state.operate }));
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
vi.mock("../pullRequest/usePullRequestActions", () => ({
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
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
  state.perform.mockReset().mockResolvedValue(undefined);
  state.fixOn.mockReset();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

async function render(element: React.ReactElement) {
  await act(async () => {
    renderer = create(element);
  });
}

async function click(label: string) {
  const button = renderer.root.findAllByProps({ "aria-label": label })[0]!;
  await act(async () => {
    await button.props.onClick();
  });
}

it.each([true, false])("merges only with source-control write (%s)", async (allowed) => {
  state.write = allowed;
  await render(
    <FindingActions
      row={row({ kind: "ready_to_merge", pr }, { environmentId: mbp, threadId: workThreadId })}
      onFixOn={state.fixOn}
    />,
  );
  await click("Merge");
  expect(state.perform.mock.calls).toEqual(allowed ? [["merge"]] : []);
});

it.each([true, false])("triages only with orchestration operate (%s)", async (allowed) => {
  state.operate = allowed;
  await render(<FindingActions row={row({ kind: "new" })} onFixOn={state.fixOn} />);
  await click("Fix on");
  await click("Backlog");
  await click("Dismiss");
  expect(state.fixOn.mock.calls).toEqual(
    allowed ? [[{ kind: "claim", expectedWorkAttempt: 0 }]] : [],
  );
  expect(state.update.mock.calls).toEqual(
    allowed
      ? [
          [{ environmentId: mini, input: { findingId, triage: "backlog" } }],
          [{ environmentId: mini, input: { findingId, triage: "dismissed" } }],
        ]
      : [],
  );
});

it("dismissing a running worker asks first, then stops it, closes its pull request and dismisses", async () => {
  await render(
    <FindingActions
      row={row({ kind: "in_review", pr }, { environmentId: mbp, threadId: workThreadId })}
      onFixOn={state.fixOn}
    />,
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

it("stop work interrupts the worker and detaches it with the current attempt", async () => {
  await render(
    <FindingActions
      row={row({ kind: "working", stalled: true }, { environmentId: mbp, threadId: workThreadId })}
      onFixOn={state.fixOn}
    />,
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
