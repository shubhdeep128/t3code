# Syncing the personal fork

`shubhdeep128/t3code` is a fork of `pingdotgg/t3code`. Its default and only
branch, `fork`, is the newest upstream `v*-nightly.*` tag plus a short stack of
fork commits. `scripts/fork/sync.ts` moves that stack onto each new nightly.

## Rules

- Nothing is pushed to `pingdotgg/t3code`.
- No tag is ever pushed to the fork. Upstream release workflows fire on tags.
- GitHub Actions stay off for the whole fork, because `release.yml` also runs on
  a cron. `gh api repos/shubhdeep128/t3code/actions/permissions --jq .enabled`
  prints `false`.
- Every push names its branch and passes `--no-follow-tags`. `--no-tags` on
  `git push` does not override `push.followTags`.

## Set up the clone

The clone keeps `origin` pointing at upstream and stores upstream tags under
`refs/upstream/tags`, a namespace that no push refspec covers.

```sh
git clone https://github.com/pingdotgg/t3code t3code-fork
cd t3code-fork
git remote add fork https://github.com/shubhdeep128/t3code
git config remote.origin.tagOpt --no-tags
git config remote.fork.tagOpt --no-tags
git config push.followTags false
git for-each-ref --format='delete %(refname)' refs/tags | git update-ref --stdin
git fetch fork fork
git switch fork
vp i
```

## Sync

Pull requests land on `fork` on GitHub, so bring the local branch up to date
first. Then sync from a clean worktree on any branch:

```sh
git switch fork && git pull --ff-only fork fork
node scripts/fork/sync.ts --dry-run
node scripts/fork/sync.ts --push
```

The script fetches upstream `v*` tags into `refs/upstream/tags`, picks the
newest nightly by version, and rebases `baseTag..fork` onto it with rerere on.
It then runs `vp i`, the typecheck of every workspace package the stack touches,
and `vp test run` on the stack's test files. `--push` pushes `fork` with
`--force-with-lease --force-if-includes --no-follow-tags` only when both checks
pass. `--dry-run` stops after the checks. The script refuses to start on a
dirty worktree or while a rebase, merge, cherry-pick or revert is in progress.

It prints one JSON line on stdout, shown here formatted:

```json
{
  "previousForkSha": "ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e",
  "baseTag": "v0.0.46-nightly.20261011.2980",
  "newestTag": "v0.0.46-nightly.20261011.2980",
  "rebased": false,
  "conflicts": 0,
  "typecheck": true,
  "tests": true,
  "pushed": false
}
```

`baseTag` is the newest nightly already in `fork`. `typecheck` and `tests` are
`null` when the checks did not run. The exit code is 0 only when there was no
conflict, both checks passed, and a requested push happened. An error prints
`sync: <message>` on stderr instead of the JSON line.

`fork` stays moved only after a passing run without `--dry-run`. A dry run, a
conflict, a failed check, a failed push or an error puts `fork` back at
`previousForkSha` and returns to the starting branch. A dry run still leaves
`node_modules` installed for the newest tag, so run `vp i` before using the
clone for anything else.

## Conflicts

A conflict in `apps/web/src/routeTree.gen.ts` alone is not a stop. The script
takes upstream's file, regenerates it with `vp run --filter @t3tools/web build`,
and continues.

Any other conflict stops the run with exit code 1. The report names the stack
commit being replayed, the last upstream commit to touch the files, the
conflicted files, and the rebase command to run by hand. Run that command,
resolve the files, `git add` them, and `git rebase --continue`. Rerere records
the resolution, so the next sync replays it without stopping. Then run the sync
again to check and push.

## Run it as a watcher

`scripts/fork/sync-watcher.md` is the prompt for a Caddie routine that runs the
sync every 6 hours, which covers upstream's 3 to 6 nightlies a day. On the
machine that runs the fork, give a Caddie agent on Full access a routine every
6 hours that does: "In ~/workspace/t3code-fork, do 'Each run' in
scripts/fork/sync-watcher.md."

The watcher stops and asks for help on any conflict outside the stack's own
files, and reports it as a fix, so Caddie starts a worker on it in T3 Code and
shows it on the routine's card.

## Roll back

Take `previousForkSha` from the JSON line of the sync to undo:

```sh
git switch fork
git reset --hard <previousForkSha>
git push --force-with-lease --no-follow-tags fork fork
```
