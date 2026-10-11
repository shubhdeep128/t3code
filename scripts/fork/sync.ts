// @effect-diagnostics nodeBuiltinImport:off - a git CLI wrapper run by hand or by an automation, outside any Effect runtime.
/**
 * Moves the fork's commit stack onto the newest upstream nightly tag.
 *
 * Run it from the fork clone: `node scripts/fork/sync.ts [--dry-run] [--push]`.
 * It prints one JSON line on stdout and sends git and vp output to stderr.
 * `fork` stays moved only when the run passes without --dry-run; every other
 * exit puts it back at `previousForkSha`. See docs/operations/personal-fork-sync.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const BRANCH = "fork";
const REMOTE = "fork";
const TAGS = "refs/upstream/tags";
const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";
const RERERE = ["-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true"];

interface Report {
  previousForkSha: string;
  baseTag: string;
  newestTag: string;
  rebased: boolean;
  conflicts: number;
  typecheck: boolean | null;
  tests: boolean | null;
  pushed: boolean;
}

interface Conflict {
  readonly files: ReadonlyArray<string>;
  readonly stackCommit: string;
  readonly upstreamCommit: string;
}

function exec(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function git(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = exec(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function vp(cwd: string, args: ReadonlyArray<string>): boolean {
  const result = NodeChildProcess.spawnSync("vp", args, { cwd, stdio: ["ignore", 2, 2] });
  if (result.error) throw result.error;
  return result.status === 0;
}

function install(cwd: string) {
  if (!vp(cwd, ["i", "--frozen-lockfile"])) throw new Error("vp i failed");
}

function tagRef(tag: string) {
  return `${TAGS}/${tag}`;
}

function gitPathExists(cwd: string, name: string) {
  return NodeFS.existsSync(NodePath.resolve(cwd, git(cwd, "rev-parse", "--git-path", name)));
}

const REBASE_STATE = ["rebase-merge", "rebase-apply"];

function rebaseInProgress(cwd: string) {
  return REBASE_STATE.some((name) => gitPathExists(cwd, name));
}

// A stopped rebase can have a clean tree, and the rebase loop would continue
// or abort it, so any operation in progress is refused like a dirty tree.
function guard(cwd: string) {
  const dirty = git(cwd, "status", "--porcelain");
  if (dirty) throw new Error(`Commit or stash these changes before syncing:\n${dirty}`);
  const busy = [...REBASE_STATE, "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].find((name) =>
    gitPathExists(cwd, name),
  );
  if (busy) throw new Error(`Finish or abort the git operation in progress (${busy}) first`);
  return {
    previousForkSha: git(cwd, "rev-parse", BRANCH),
    startRef:
      exec(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout ||
      git(cwd, "rev-parse", "HEAD"),
  };
}

// A refspec takes one `*`, so this fetches every `v*` tag and `nightlyTags`
// filters. An empty --refmap keeps configured refspecs from also writing refs/tags.
function fetchTags(cwd: string) {
  git(cwd, "fetch", "origin", "--no-tags", "--refmap=", `+refs/tags/v*:${TAGS}/v*`);
}

function nightlyTags(cwd: string): ReadonlyArray<string> {
  return git(
    cwd,
    "for-each-ref",
    "--sort=-version:refname",
    "--format=%(refname:strip=3)",
    `${TAGS}/v*-nightly.*`,
  )
    .split("\n")
    .filter(Boolean);
}

function newestTag(cwd: string): string {
  const [newest] = nightlyTags(cwd);
  if (!newest) throw new Error("origin has no v*-nightly.* tags");
  return newest;
}

// The newest nightly already inside `fork` is where the stack starts, so
// `baseTag..fork` is exactly the stack, even if upstream rewrote history since.
function baseTag(cwd: string): string {
  const base = nightlyTags(cwd).find(
    (tag) => exec(cwd, ["merge-base", "--is-ancestor", tagRef(tag), BRANCH]).ok,
  );
  if (!base) throw new Error(`${BRANCH} does not contain any nightly tag`);
  return base;
}

function unmergedFiles(cwd: string) {
  return git(cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

// Taking upstream's file and regenerating keeps every route from both sides,
// which a textual merge of the generated file cannot promise.
function resolveRouteTree(cwd: string) {
  git(cwd, "checkout", "--ours", "--", ROUTE_TREE);
  install(cwd);
  if (!vp(cwd, ["run", "--filter", "@t3tools/web", "build"])) {
    throw new Error(`vp build failed while regenerating ${ROUTE_TREE}`);
  }
  git(cwd, "add", ROUTE_TREE);
}

function rebaseArgs(base: string, newest: string) {
  return [...RERERE, "rebase", "--no-update-refs", "--onto", tagRef(newest), tagRef(base), BRANCH];
}

// Returns the first conflict rerere and the route tree rule cannot settle.
function rebase(cwd: string, base: string, newest: string): Conflict | undefined {
  let step = exec(cwd, rebaseArgs(base, newest));
  while (rebaseInProgress(cwd)) {
    const files = unmergedFiles(cwd);
    if (files.length === 1 && files[0] === ROUTE_TREE) {
      resolveRouteTree(cwd);
    } else if (files.length > 0) {
      return {
        files,
        stackCommit: git(cwd, "log", "-1", "--format=%h %s", "REBASE_HEAD"),
        upstreamCommit: git(
          cwd,
          "log",
          "-1",
          "--format=%h %s",
          `${tagRef(base)}..${tagRef(newest)}`,
          "--",
          ...files,
        ),
      };
    }
    step = exec(cwd, [...RERERE, "rebase", "--continue"]);
    if (!step.ok && unmergedFiles(cwd).length === 0) {
      throw new Error(`git rebase --continue failed:\n${step.stderr}`);
    }
  }
  if (!step.ok) throw new Error(`git rebase failed:\n${step.stderr}`);
  return undefined;
}

// The root package's typecheck runs every workspace, so files outside a
// workspace package only reach the tests.
function owningPackage(cwd: string, file: string): string | undefined {
  for (let dir = NodePath.dirname(file); dir !== "."; dir = NodePath.dirname(dir)) {
    const manifest = NodePath.join(cwd, dir, "package.json");
    if (!NodeFS.existsSync(manifest)) continue;
    const pkg = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.typecheck ? pkg.name : undefined;
  }
  return undefined;
}

function check(cwd: string, newest: string) {
  const files = git(cwd, "diff", "--name-only", `${tagRef(newest)}..${BRANCH}`)
    .split("\n")
    .filter(Boolean);
  const packages = new Set(
    files.map((file) => owningPackage(cwd, file)).filter((name) => name !== undefined),
  );
  const testFiles = files.filter(
    (file) => /\.test\.tsx?$/.test(file) && NodeFS.existsSync(NodePath.join(cwd, file)),
  );
  install(cwd);
  let typecheck = true;
  for (const name of packages) {
    typecheck = vp(cwd, ["run", "--filter", name, "typecheck"]) && typecheck;
  }
  const tests = testFiles.length === 0 || vp(cwd, ["test", "run", ...testFiles]);
  return { typecheck, tests };
}

// `--no-tags` on push does not override push.followTags; `--no-follow-tags` does.
function push(cwd: string) {
  git(cwd, "push", "--force-with-lease", "--force-if-includes", "--no-follow-tags", REMOTE, BRANCH);
}

function restore(cwd: string, sha: string) {
  if (rebaseInProgress(cwd)) git(cwd, "rebase", "--abort");
  git(cwd, "checkout", "--quiet", "--force", "-B", BRANCH, sha);
}

function printConflict(conflict: Conflict, base: string, newest: string) {
  process.stderr.write(
    [
      `Conflict while replaying ${conflict.stackCommit} onto ${newest}.`,
      `Upstream commit: ${conflict.upstreamCommit || "unknown"}`,
      "Conflicted files:",
      ...conflict.files.map((file) => `  ${file}`),
      "Resolve it by hand with rerere on, then run the sync again:",
      `  git ${rebaseArgs(base, newest).join(" ")}`,
      "",
    ].join("\n"),
  );
}

function sync(cwd: string, options: { readonly dryRun: boolean; readonly push: boolean }) {
  const { previousForkSha, startRef } = guard(cwd);
  const wantPush = options.push && !options.dryRun;
  let passed = false;
  try {
    fetchTags(cwd);
    const newest = newestTag(cwd);
    const base = baseTag(cwd);
    const report: Report = {
      previousForkSha,
      baseTag: base,
      newestTag: newest,
      rebased: false,
      conflicts: 0,
      typecheck: null,
      tests: null,
      pushed: false,
    };
    const conflict = rebase(cwd, base, newest);
    if (conflict) {
      report.conflicts = conflict.files.length;
      printConflict(conflict, base, newest);
      return { report, passed };
    }
    report.rebased = base !== newest;
    Object.assign(report, check(cwd, newest));
    if (wantPush && report.typecheck && report.tests) {
      push(cwd);
      report.pushed = true;
    }
    passed = report.typecheck === true && report.tests === true && report.pushed === wantPush;
    return { report, passed };
  } finally {
    if (options.dryRun || !passed) restore(cwd, previousForkSha);
    git(cwd, "checkout", "--quiet", startRef);
  }
}

const { values } = NodeUtil.parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    push: { type: "boolean", default: false },
  },
});

try {
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel");
  const { report, passed } = sync(cwd, { dryRun: values["dry-run"], push: values.push });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`sync: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
