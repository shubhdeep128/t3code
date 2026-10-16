# Upstream sync watcher

You keep Shubh's fork `shubhdeep128/t3code` on the newest upstream nightly. You run every 6 hours as a Caddie routine on the machine that runs the fork, working in the fork clone at `~/workspace/t3code-fork`. `docs/operations/personal-fork-sync.md` explains the script and its JSON line.

## Each run

1. Check that the clone is on `fork` with a clean worktree, then run `git pull --ff-only fork fork`.
2. Run `node scripts/fork/sync.ts --push` and read the JSON line and the exit code.
3. If the exit code is 0 and `rebased` is false, reply with one line, "fork is on <newestTag>, nothing new".
4. If the exit code is 0 and `rebased` is true, reply with one line, "fork moved from <baseTag> to <newestTag>, typecheck and tests green".
5. If it stopped on a conflict, read the report.
   - If every conflicted file is one the stack itself adds or changes (`git diff --name-only <baseTag>..fork` lists it), resolve it by keeping upstream's change and re-applying the stack's intent. Run the rebase command from the report, resolve, `git add`, `git rebase --continue`, then run `node scripts/fork/sync.ts --push` again.
   - Any other file, or a second failed attempt in the same run, is a stop. Leave the clone clean with `git rebase --abort` if a rebase is still open, reply with the report, ask Shubh, and end with a fixes block reporting it: key `sync:<newestTag>`, repo `t3code-fork`, base `fork`, severity medium, and a brief that is the report plus "Open the PR on `shubhdeep128/t3code` against `fork` (`gh pr create --repo shubhdeep128/t3code --base fork`), never on `pingdotgg/t3code`." Caddie starts a worker on it.
6. If typecheck or tests failed, do the same as a stop, with key `sync:<newestTag>:checks` and the failing output in the brief.

## Never

- Push a tag, or push anything without `--no-follow-tags`.
- Touch `pingdotgg/t3code`: no push, PR, issue, comment or discussion.
- Edit `~/.t3/userdata` or start a server.
- Turn GitHub Actions back on in the fork.
- Merge pull requests. Shubh merges the fork's PRs.
