# Changelog

All notable changes to `@jachy/pi-git-sync` are documented here.

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

[0.3.0]: https://github.com/jachy-h/pi-git-sync/releases/tag/v0.3.0
