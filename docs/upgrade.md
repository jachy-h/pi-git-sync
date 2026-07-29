# v0.5 Upgrade Guide

## Scope

This guide covers upgrades from `0.4.x` to `0.5.x`, plus the compatible v0.2/v0.3 state migration path retained by current releases.

### v0.5 compatibility

v0.5 is an internal orchestration refactor: setup, pull/push integration, apply, and extension progress handling now have explicit phase boundaries. It does **not** change the public `/pisync` command, `pi-sync.json` schema v2, or local state schema v3.

No repository conversion, state migration, force push, hard reset, or device-branch cleanup is required. Upgrade the extension, then run `/pisync status` followed by `/pisync` normally. Existing pending conflict or `apply-failed` recovery remains handled by the normal `/pisync` entry point.

## Before upgrading

1. Ensure Pi `0.82.1` or newer and Node.js `>=22.19.0` are installed.
2. Make sure the config repository is clean and pushed.
3. Keep a copy of the agent directory if the repository contains custom extensions or
   packages.

## Legacy state migration

On the first command that loads state, pi-git-sync:

1. Backs up `<config-repo>/.pi-sync/state.json` as a versioned `state.v2.backup-*.json` file.
2. Converts string `pendingOperation` values to structured v3 objects.
3. Reconciles a v2 baseline only when the local and repository hashes match.
4. Removes baseline entries when both sides are absent.
5. Preserves the old baseline and records `migrationReport.conflicts` when the sides differ,
   a path is unavailable, or a symlink is encountered.
6. Atomically writes the migrated v3 state.

A migration conflict is intentionally not resolved automatically. Use `/pisync status`,
resolve the file manually, then run `/pisync` again.

## Command migration (v0.3 compatibility)

The following write commands are removed in v0.3 and are not aliases:

- `/pisync init [url]`
- `/pisync pull`
- `/pisync push`
- `/pisync push --continue`

Run `/pisync` instead. On an uninitialized machine it asks for the Git URL and performs
setup. On an initialized machine it runs the complete pull-then-push flow. `/pisync status`
and `/pisync diff` remain read-only diagnostic commands. Existing pending conflict and
apply-failed operations are recovered by the next `/pisync` invocation.

## Branch behavior

`pi-sync.json.branch` is now the single target branch for setup, status, sync, and
rebase. The tool no longer infers the target from the current branch or assumes `main`.
A clean worktree may be switched to the configured branch. Dirty, merge, and rebase states
are blocked instead of being switched automatically.

## Conflict handling (v0.4+)

A true content conflict now presents explicit choices from `/pisync`: agent-assisted
semantic merge, manual abort, current-device content for conflict paths, or shared-remote
content for conflict paths. `Use local` and `Use remote` do not replace an entire branch;
non-conflicting changes from both sides remain in the normal merge commit. The current-device
branch remains on `origin` for recovery, and neither flow uses force push.

Abort remains compatible with the v0.3 manual workflow: merge the published device branch
into the configured shared branch, push normally, then run `/pisync` again.

## Package approval

New or changed sources in `sync/settings.json` require explicit approval before Pi runs
`pi install`. Approved sources may be remembered in the local, non-synced trust store:

```text
<config-repo>/.pi-sync/package-trust.json
```

Package sources are still passed to Pi as argv values, never through a shell. If an install
fails, pi-git-sync restores settings and attempts to remove newly installed packages and
reinstall previous sources. A `rollbackErrors` result means manual package recovery is
required; the operation is not reported as successful.

## Path safety

Repositories, sync roots, agent files, backup files, and restore targets now reject symlink
components and paths that escape their trusted root. Existing repository or agent symlinks
must be replaced with regular files/directories before syncing. Do not rely on the previous
behavior of silently skipping symlinks.

## Bootstrap changes

Bootstrap now installs the published extension package:

```bash
pi install npm:@jachy/pi-git-sync
```

It does not install the config repository as a Pi package and does not clone the repository
itself. After installation, run `/pisync` and enter the repository URL when prompted.

Bootstrap removes any versioned legacy source before installing this unversioned source, preventing duplicate `/pisync` commands.

## Rollback and downgrade

`0.1.x` should not be used to read a v3 state file. Keep the generated v2 backup if a manual
downgrade is required, and restore it only after stopping pi-git-sync. The v2 backup is a
recovery aid, not a guarantee that an older version understands every v0.2 operation.

## Verification

After upgrading, run:

```bash
npm run test:ci
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
npm pack --dry-run
```

Then run `/pisync status` and confirm that the configured branch, repository path, and
pending operation state are healthy. Finally run `/pisync` to verify the complete sync flow.
