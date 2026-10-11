// @effect-diagnostics nodeBuiltinImport:off - drives the real sync CLI against throwaway git repos.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.join(import.meta.dirname, "sync.ts");
const OLD = "v0.0.1-nightly.20260101.9";
const NEW = "v0.0.1-nightly.20260101.10";
const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";
const PACKAGE = JSON.stringify({ name: "pkg", scripts: { typecheck: "tsc" } });
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Sync Test",
  GIT_AUTHOR_EMAIL: "sync@example.com",
  GIT_COMMITTER_NAME: "Sync Test",
  GIT_COMMITTER_EMAIL: "sync@example.com",
};
const FAKE_VP = `#!/bin/sh
case "$*" in
  *typecheck*) exit "\${FAKE_TYPECHECK_STATUS:-0}" ;;
  *"test run"*) exit "\${FAKE_TEST_STATUS:-0}" ;;
  *build*) printf 'regenerated\\n' > ${ROUTE_TREE} ;;
esac
exit 0
`;

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

function commit(cwd: string, message: string, files: Record<string, string>, date: string) {
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, file), content);
  }
  git(cwd, "add", "-A");
  NodeChildProcess.execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

// Upstream tags OLD (annotated, so dated now), then NEW on a commit dated
// earlier, and puts a stable tag that sorts above both on NEW. `fork` is OLD
// plus two stack commits. The clone sits on `main`, keeps upstream's tags in
// refs/tags and follows tags on push, so a push that leaks a tag shows up.
function setup(
  changes: { upstream?: Record<string, string>; stack?: Record<string, string> } = {},
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-"));
  roots.push(root);
  const upstream = NodePath.join(root, "upstream");
  const clone = NodePath.join(root, "clone");
  NodeFS.mkdirSync(NodePath.join(root, "bin"));
  NodeFS.writeFileSync(NodePath.join(root, "bin", "vp"), FAKE_VP, { mode: 0o755 });

  NodeFS.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  commit(
    upstream,
    "base",
    { "shared.txt": "base\n", [ROUTE_TREE]: "base\n" },
    "2026-01-01T00:00:00Z",
  );
  git(upstream, "tag", "-a", "-m", OLD, OLD);
  commit(
    upstream,
    "new nightly",
    changes.upstream ?? { "upstream.txt": "new\n" },
    "2025-12-01T00:00:00Z",
  );
  git(upstream, "tag", NEW);
  git(upstream, "tag", "v0.0.2");

  git(root, "init", "-q", "--bare", "fork.git");
  git(root, "clone", "-q", upstream, clone);
  git(clone, "remote", "add", "fork", NodePath.join(root, "fork.git"));
  git(clone, "switch", "-q", "-c", "fork", "main~1");
  commit(
    clone,
    "stack one",
    { "pkg/package.json": PACKAGE, "pkg/a.ts": "export {};\n" },
    "2026-01-02T00:00:00Z",
  );
  commit(
    clone,
    "stack two",
    changes.stack ?? { "pkg/a.test.ts": "export {};\n" },
    "2026-01-03T00:00:00Z",
  );
  git(clone, "push", "-q", "fork", "fork");
  git(clone, "config", "push.followTags", "true");
  git(clone, "switch", "-q", "main");

  return { root, clone, previousForkSha: git(clone, "rev-parse", "fork") };
}

function sync(
  repo: ReturnType<typeof setup>,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) {
  const result = NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo.clone,
    encoding: "utf8",
    env: { ...ENV, PATH: `${NodePath.join(repo.root, "bin")}:${process.env.PATH}`, ...env },
  });
  return {
    status: result.status,
    report: result.stdout ? (JSON.parse(result.stdout) as unknown) : undefined,
    stderr: result.stderr,
  };
}

function expectUnmoved(repo: ReturnType<typeof setup>) {
  expect(git(repo.clone, "rev-parse", "fork")).toBe(repo.previousForkSha);
  expect(git(repo.clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(git(repo.clone, "status", "--porcelain")).toBe("");
}

describe("scripts/fork/sync.ts", () => {
  it("rebases the stack onto the newest nightly by version and pushes it without tags", () => {
    const repo = setup();

    const result = sync(repo, ["--push"]);

    expect(result.report).toEqual({
      previousForkSha: repo.previousForkSha,
      baseTag: OLD,
      newestTag: NEW,
      rebased: true,
      conflicts: 0,
      typecheck: true,
      tests: true,
      pushed: true,
    });
    expect(result.status).toBe(0);
    expect(git(repo.clone, "log", "--format=%s", "main..fork").split("\n")).toEqual([
      "stack two",
      "stack one",
    ]);
    expect(git(repo.clone, "rev-parse", "fork~2")).toBe(git(repo.clone, "rev-parse", "main"));
    expect(git(repo.clone, "ls-remote", "fork", "refs/heads/fork")).toBe(
      `${git(repo.clone, "rev-parse", "fork")}\trefs/heads/fork`,
    );
    expect(git(repo.clone, "ls-remote", "--tags", "fork")).toBe("");
  });

  it("puts fork back after a passing dry run", () => {
    const repo = setup();

    const result = sync(repo, ["--dry-run", "--push"]);

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ rebased: true, typecheck: true, pushed: false });
    expectUnmoved(repo);
    expect(git(repo.clone, "ls-remote", "fork", "refs/heads/fork")).toBe(
      `${repo.previousForkSha}\trefs/heads/fork`,
    );
  });

  it("stops at a conflict, names the file and both commits, and leaves fork in place", () => {
    const repo = setup({
      upstream: { "shared.txt": "upstream\n" },
      stack: { "shared.txt": "stack\n" },
    });

    const result = sync(repo, []);

    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({ rebased: false, conflicts: 1, typecheck: null });
    expect(result.stderr).toContain("  shared.txt\n");
    expect(result.stderr).toMatch(/replaying [0-9a-f]+ stack two/);
    expect(result.stderr).toMatch(/Upstream commit: [0-9a-f]+ new nightly/);
    expectUnmoved(repo);
  });

  it("regenerates a conflicting route tree instead of stopping", () => {
    const repo = setup({
      upstream: { [ROUTE_TREE]: "upstream\n" },
      stack: { [ROUTE_TREE]: "stack\n" },
    });

    const result = sync(repo, []);

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ rebased: true, conflicts: 0 });
    expect(git(repo.clone, "show", `fork:${ROUTE_TREE}`)).toBe("regenerated");
  });

  it("refuses a dirty worktree before fetching", () => {
    const repo = setup();
    NodeFS.writeFileSync(NodePath.join(repo.clone, "stray.txt"), "stray\n");

    const result = sync(repo, []);

    expect(result.status).toBe(1);
    expect(result.report).toBeUndefined();
    expect(result.stderr).toContain("?? stray.txt");
    expect(git(repo.clone, "for-each-ref", "refs/upstream/tags")).toBe("");
  });

  it("refuses to start while another rebase is stopped, and leaves it alone", () => {
    const repo = setup();
    git(repo.clone, "switch", "-q", "fork");
    NodeChildProcess.execFileSync("git", ["rebase", "-q", "-i", "HEAD~1"], {
      cwd: repo.clone,
      env: { ...ENV, GIT_SEQUENCE_EDITOR: "echo break >" },
    });

    const result = sync(repo, []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("operation in progress (rebase-merge)");
    expect(NodeFS.existsSync(NodePath.join(repo.clone, ".git", "rebase-merge"))).toBe(true);
    expect(git(repo.clone, "for-each-ref", "refs/upstream/tags")).toBe("");
  });

  it("puts fork back when a check throws on a dry run", () => {
    const repo = setup({ stack: { "pkg/package.json": "{ not json" } });

    const result = sync(repo, ["--dry-run"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("JSON");
    expectUnmoved(repo);
  });

  it("does not push when typecheck and tests fail", () => {
    const repo = setup();

    const result = sync(repo, ["--push"], { FAKE_TYPECHECK_STATUS: "1", FAKE_TEST_STATUS: "1" });

    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({ typecheck: false, tests: false, pushed: false });
    expectUnmoved(repo);
    expect(git(repo.clone, "ls-remote", "fork", "refs/heads/fork")).toBe(
      `${repo.previousForkSha}\trefs/heads/fork`,
    );
  });
});
