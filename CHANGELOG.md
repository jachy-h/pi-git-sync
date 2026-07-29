# Changelog

All notable changes to `@jachy/pi-git-sync` are documented here.

## [0.5.0] - 2026-07-29

### Added

- Explicit lock-free setup, pull, push, apply, and extension operation-runner phase boundaries.
- Core lifecycle contracts for setup preflight/onboarding, lock contention, stale preparation, rollback/retry, pending recovery, and pull/push phase outcomes.
- Coverage gates for command orchestration and the extracted extension operation runner.

### Changed

- `PiSyncCommands` now focuses on public façade behavior, lifecycle, lock ownership, phase ordering, and conflict coordination.
- Setup, apply, pull/push Git integration, and extension progress/cancel/watchdog behavior retain their existing public semantics while executing through dedicated modules.
- CI runs core coverage and the two-device E2E suite separately, so E2E executes once per `test:ci` invocation.

### Compatibility

- No public command, config schema v2, state schema v3, device-branch, backup, package-approval, or secret-scan behavior change.
- See [the upgrade guide](docs/upgrade.md) for the v0.5 verification steps.

## [0.4.0] - 2026-07-28

### Added

- Structured `sync_conflict` results with shared/device branch OIDs and affected paths.
- Four-way conflict UI: agent handoff, manual abort, current-device selection, or shared-remote selection.
- Safe automatic path-level resolution with fresh fetch/ref/worktree validation, normal merge commits, validation, secret scanning, backup/apply, and no force push.
- Current-device branch retention and modify/delete conflict coverage.

### Changed

- Conflict UI dispatch now uses structured result details rather than message text.
- Conflict resolution Git primitives live in `src/conflict-resolution.ts`.

## [0.3.0] - 2026-07-27

### Added

- Unified `/pisync` setup and synchronization entry point.
- Lifecycle detection for uninitialized, initialized, and broken installations.
- Automatic recovery for legacy pending operations.
- Pull-then-push orchestration with aggregated reload handling.
- Two-device end-to-end coverage for convergence and conflict preservation.

### Changed

- `/pisync status` and `/pisync diff` remain the only public subcommands.
- Removed public write commands: `/pisync init`, `/pisync pull`, `/pisync push`, and
  `/pisync push --continue`.
- Package approval re-enters synchronization after approval so state is revalidated.
- Bootstrap and documentation now use the unified `/pisync` workflow.

### Compatibility

- Existing v0.2.x repositories and state files migrate in place.
- Legacy pending operations are recovered by the next `/pisync` invocation.
- See [the upgrade guide](docs/upgrade.md) for migration and rollback notes.

[0.5.0]: https://github.com/jachy-h/pi-git-sync/releases/tag/v0.5.0
[0.3.0]: https://github.com/jachy-h/pi-git-sync/releases/tag/v0.3.0
