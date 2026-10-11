# Watchers

Open **Watchers** from the sidebar or the command palette (**Open Watchers**). It has no default
keyboard shortcut.

## What a watcher is

A watcher is a scheduled task whose agent reports what it finds. Every scheduled task shows in
**Watchers → Watchers** as a card with its last run, its next run, and how many of its findings
are still open. **Run now**, the pause switch, and **Edit** use the same task as
**Settings → Scheduled tasks**, and **New watcher** opens the same editor.

An agent files a finding with the `report_finding` tool. Findings with the same fingerprint in a
project collapse into one, so two watchers that notice the same problem do not file it twice. Once
the fix for a finding has merged, the same fingerprint opens a new finding that names the old one.

## Today

**Watchers → Today** lists findings from every connected environment in one place, each tagged with
the environment it came from, in these groups:

- **Needs you**: a worker asked a question, failed, or its thread is gone.
- **Ready to merge**: the worker's pull request is approved, green, and mergeable.
- **New**: nobody is on it yet.
- **In progress**: a worker is on it, its pull request is in review, or the work runs on a machine
  this app is not connected to.
- **Merged**: the fix landed.

Rows sort by severity, then by when they were last seen. Select a row to read its evidence, the
watcher that filed it, the worker thread, and the pull request. Opening a finding refreshes its
pull request from the host, so the checks and review state are current.

**Backlog** shows what you set aside or dismissed, and **Runs** lists every firing of every watcher
with its outcome, including firings that were skipped because the previous run was still going.

## Fix a finding

Choose **Fix on** to send a finding to a worker. Pick the environment, the project on it, and the
base branch. The worker starts in its own worktree on a new `finding/…` branch with the finding as
its brief. It opens a pull request and stops there; it never merges. The worker uses the model and
mode of the watcher that filed the finding, or the project's defaults when a thread filed it.

A finding is claimed before its worker starts, so two people on two machines cannot both start
one. If someone else got there first, the dialog says so and the row shows their worker.

**Stop work** interrupts the worker and leaves the finding as new. **Start again** after a failed
or missing worker opens **Fix on** for a fresh attempt.

## Triage and merge

- **Backlog** sets a finding aside. It is offered only when no worker is on it. **Restore** brings
  it back.
- **Dismiss** hides a finding. Dismissing one with a running worker asks whether to stop the worker
  and close its pull request. **Reopen** brings it back.
- **Merge** merges the worker's pull request with the repository's merge method, the same as on the
  pull request page. It needs source control write access on the worker's environment.

## Keyboard

On **Today**, press `j` and `k` to move between findings, `Enter` to move into the selected
finding's actions, `f` for **Fix on** or **Start again**, `b` for **Backlog** or **Restore**, `d`
for **Dismiss** or **Reopen**, and `m` for **Merge**. `Escape` returns to the list, then to the
previous page.
