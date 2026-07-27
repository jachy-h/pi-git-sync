# v0.2 Upgrade Guide

## Scope

This guide covers upgrades from `0.1.x` to `0.2.x`. The config repository layout remains
compatible, but the local sync state changes from schema v2 to schema v3.

## Before upgrading

1. Ensure Pi `0.82.1` or newer and Node.js `>=22.19.0` are installed.
2. Make sure the config repository is clean and pushed.
3. Run `/pisync doctor` and keep a copy of the agent directory if the repository contains
   custom extensions or packages.

## State migration

On the first command that loads state, pi-git-sync:

1. Backs up `.pi-sync/state.json` as a versioned `state.v2.backup-*.json` file.
2. Converts string `pendingOperation` values to structured v3 objects.
3. Reconciles a v2 baseline only when the local and repository hashes match.
4. Removes baseline entries when both sides are absent.
5. Preserves the old baseline and records `migrationReport.conflicts` when the sides differ,
   a path is unavailable, or a symlink is encountered.
6. Atomically writes the migrated v3 state.

A migration conflict is intentionally not resolved automatically. Use `/pisync status` and
`/pisync doctor`, resolve the file manually, then run the appropriate capture or apply
command.

## Branch behavior

`pi-sync.json.branch` is now the single target branch for init, status, pull, push, rebase,
and doctor. The tool no longer infers the target from the current branch or assumes `main`.
A clean worktree may be switched to the configured branch. Dirty, merge, and rebase states
are blocked instead of being switched automatically.

## Package approval

New or changed sources in `sync/settings.json` require explicit approval before Pi runs
`pi install`. Approved sources may be remembered in the local, non-synced trust store:

```text
~/.pi/agent/.pi-sync/package-trust.json
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
pi install npm:@jachy/pi-git-sync@<version>
```

It does not install the config repository as a Pi package and does not clone the repository
itself. After installation, run:

```text
/pisync init <repo-url>
```

Use `PI_GIT_SYNC_VERSION` to pin a bootstrap installation to a specific published version.

## Rollback and downgrade

`0.1.x` should not be used to read a v3 state file. Keep the generated v2 backup if a manual
downgrade is required, and restore it only after stopping pi-git-sync. The v2 backup is a
recovery aid, not a guarantee that an older version understands every v0.2 operation.

## Verification

After upgrading, run:

```bash
npm run typecheck
npm test
npm run test:ci
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

Then run `/pisync doctor` and confirm that the configured branch, repository path, pending
operation state, package trust, and path safety checks are healthy.
