# pi-git-sync

Sync Pi configuration across machines via a GitHub private repository.

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [中文文档](./README.zh.md)

---

## How It Works

pi-git-sync keeps your Pi configuration in a **private Git repository** and syncs it across all your machines. It uses a **three-way comparison** model based on a sync baseline to detect local changes, remote changes, and conflicts.

Key features:

- Glob-based include/exclude whitelist — no manual per-file mappings needed
- `settings.json` shared as a whole file — simple and predictable
- Three-way diff with sync baseline — accurate detection of creates, deletes, and bilateral conflicts
- Full push chain: `capture → commit → fetch → rebase → push → apply`
- Conflict-safe device branches with explicit manual Git merges
- Config repo is a standalone Git repo, not a Pi Package
- All synced content lives under a single `sync/` directory

---

## Usage

### Prerequisites

- Pi `0.82.1` or newer (Node.js `>=22.19.0`)
- Git + SSH configured (for GitHub)

### 1. Create an Empty Private Repo on GitHub

Create an empty private repo (any name you like). Do **NOT** check "Initialize with README".

### 2. Install pi-git-sync

```bash
pi install npm:@jachy/pi-git-sync
```

The config repository is user data, not a Pi package. Do not run `pi install` on the
config repository itself.

### Optional Bootstrap

The bootstrap script installs the extension and then tells Pi to run `init`; it does
not clone or install the config repository as code:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/jachy-h/pi-git-sync/main/scripts/bootstrap.sh) \
  git@github.com:<your-username>/<your-repo>.git
```

The package source is intentionally unversioned. This lets Pi maintain one installation and prevents duplicate `/pisync` commands.

### 3. One-Click Init

In Pi, provide your repo URL. For an empty repo, pi-git-sync treats the initiating
machine as the source of truth: it scaffolds the config structure, captures the current
local configuration (including `settings.json` and its `packages[]`), then commits and
pushes it automatically.

```bash
/pisync init git@github.com:<your-username>/<your-repo>.git
```

Generated repo structure:

```text
<your-repo>/
├── .gitignore
├── pi-sync.json              # Sync configuration
└── sync/                     # All synced content lives here
    ├── settings.json          # Shared settings (whole file)
    ├── AGENTS.md              # (optional)
    ├── SYSTEM.md              # (optional)
    ├── APPEND_SYSTEM.md       # (optional)
    ├── keybindings.json       # (optional)
    ├── extensions/            # Custom extensions
    ├── skills/                # Skills
    ├── prompts/               # Prompt templates
    └── themes/                # Themes
```

### 4. Sync Later Changes

The initial `/pisync init` already captures the current local configuration into an
empty repository. If an older version left the generated settings placeholder with an
empty sync baseline, `/pisync push` detects and calibrates that specific state without
manual file copying. For changes made afterward, run:

```bash
/pisync push
```

The `push` command combines capture → commit → fetch → rebase → push → apply in one
step, with a confirmation prompt after showing you the diff.

---

## Commands

| Command | Description |
| --- | --- |
| `/pisync` | Interactive TUI menu |
| `/pisync init [url]` | Initialize or clone a config repo (`--force` to rebuild) |
| `/pisync status` | Show detailed sync status (three-way comparison + git info) |
| `/pisync diff` | Show pending changes between agent and repo |
| `/pisync pull` | Pull remote changes and apply to agent |
| `/pisync push` | Capture, commit, and push local changes |
| `/pisync push --continue` | Continue push after resolving rebase conflicts |
| `/pisync capture` | Import local config changes into repo (no commit/push) |
| `/pisync doctor` | Run diagnostic checks |
| `/pisync rollback` | Rollback to last backup |

---

## What Gets Synced

| Content | Method |
| --- | --- |
| Extensions | Copied from `sync/extensions/` into agent directory |
| Skills | Copied from `sync/skills/` into agent directory |
| Prompts | Copied from `sync/prompts/` into agent directory |
| Themes | Copied from `sync/themes/` into agent directory |
| `settings.json` | Whole-file copy (no key-level merge) |
| `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md` | Copied into agent directory |
| `keybindings.json` | Copied into agent directory |
| Third-party Packages | Declared in `sync/settings.json` → `packages[]`; new or changed sources require approval before installation (local-only packages are never auto-removed) |

## What Never Gets Synced

Hard deny list (built-in, not configurable):

`auth.json`, `sessions/**`, `trust.json`, `models-store.json`, `npm/**`, `git/**`, `node_modules/**`, `.pi-sync/**`, `**/.env`, `**/*.pem`, `**/id_rsa`, `**/id_ed25519`

Also: hidden files (except `.gitignore`) are excluded. Symlinks and symlink components are blocked with an error; they are never followed or silently skipped.

---

## Config Reference (`pi-sync.json`)

```json
{
  "schemaVersion": 2,
  "branch": "main",
  "root": "sync",
  "include": [
    "settings.json",
    "AGENTS.md",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
    "keybindings.json",
    "extensions/**",
    "skills/**",
    "prompts/**",
    "themes/**"
  ],
  "exclude": [
    "**/.DS_Store",
    "**/*.tmp",
    "**/*.log"
  ],
  "delete": "tracked",
  "security": {
    "scanSecretsBeforePush": true
  }
}
```

### Fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `2` | — | Config schema version (currently `2`) |
| `branch` | `string` | `"main"` | The single Git branch used by init, status, pull, push, rebase, and doctor |
| `root` | `string` | `"sync"` | Root directory inside the repo for synced content |
| `include` | `string[]` | — | Glob whitelist (relative to `root`). Supports `*`, `**`, `?` |
| `exclude` | `string[]` | `[]` | Glob patterns to exclude (lower priority than built-in hard deny) |
| `delete` | `"tracked"` \| `"none"` | `"tracked"` | `"tracked"`: delete agent files when removed from repo. `"none"`: never delete |
| `security.scanSecretsBeforePush` | `boolean` | `true` | Scan staged files for secrets (API keys, tokens, private keys) before pushing |

---

## Sync Model

### Three-Way Comparison

Every sync operation compares three states:

```text
B = Baseline (last synced commit hash)  — stored in `<config-repo>/.pi-sync/state.json` (Git ignored)
L = Local   (current agent files)
R = Remote  (current repo sync/ files)
```

This gives accurate detection of:

| Scenario | Classification | Action |
| --- | --- | --- |
| Only you changed a file | `local_only` | Captured on push |
| Only remote changed a file | `remote_only` | Applied on pull |
| Both changed the same file differently | `both_modified` | **Blocked** — resolve manually |
| You created a new file | `local_created` | Captured on push |
| Remote created a new file | `remote_created` | Applied on pull |
| You deleted a tracked file | `local_deleted` | Captured on push |
| Remote deleted a tracked file | `remote_deleted` | Applied on pull (if `delete: "tracked"`) |
| Both made the same change | `converged` | Baseline updated, no conflict |

### Push Flow

```text
capture (agent → repo working tree)
  → commit
  → fetch origin
  → rebase onto origin/<configured branch>
  → push <configured branch>
  → push current-device snapshot branch
  → apply (new HEAD → agent)
```

Each device has one persistent, unique remote snapshot branch: `pisync-device/<hostname>-<UUID>`. A hostname is not unique; the UUID is stored only in `<config-repo>/.pi-sync/state.json`. That directory is Git-ignored and never synced. The tool therefore never scans remote branches and guesses a “unique device branch.”

On conflict, pi-git-sync pushes current-device changes to that device branch and restores the configured branch to remote `main` (or `pi-sync.json.branch`). At that point `main` and the device branch are **intentionally different**. Merge the current device branch into the shared branch:

```bash
cd <sync-repository>
git fetch origin
git switch main
git merge origin/pisync-device/<hostname>-<UUID>
# resolve conflicts, then
git add <files>
git commit
git push origin main
```

### Pull Flow

```text
fetch origin
  → check for local un-captured changes (block if any)
  → fast-forward only (block if diverged)
  → apply (new HEAD → agent)
```

---

## Safety

- Pull uses **fast-forward only**; stops on divergence
- **Bilateral conflict detection** — never silently overwrites both sides
- Automatic **secret scanning** before push (API keys, tokens, private keys)
- **Atomic config writes** (temp file → rename)
- Automatic **backup** before every apply, with **fail-closed rollback** support
- **Concurrency lock** prevents multiple Pi instances from syncing simultaneously
- **Built-in hard deny list** prevents syncing credentials (not user-overridable)
- Repo and agent **path-boundary checks** block symlink escapes
- Remote package additions and changes require explicit approval; failed installs attempt package rollback
- Settings.json **portability validation** — warns about absolute paths and machine-specific content

---

## Development

### Local Debugging

Symlink into Pi extensions directory:

```bash
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync
```

Then `/reload` in Pi to pick up changes.

Or load temporarily via `-e` (does not write to settings.json):

```bash
pi -e ./index.ts
```

### Run Tests

```bash
npm install
npm test           # unit/integration suite
npm run test:ci    # typecheck + coverage + E2E
npm run test:watch # watch mode
npm run typecheck  # type check
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

### Upgrade Notes

When upgrading from `0.1.x`, keep the existing config repository and run the normal
`/pisync init <repo-url>` or `/pisync pull` flow. The local sync state migrates from
schema v2 to v3 after backing up the old state. Equal local/repo files are reconciled;
conflicting files are preserved and reported instead of choosing a side.

See [the full upgrade guide](./docs/upgrade.md).

### Project Structure

```text
pi-git-sync/
├── index.ts              # Extension entry point
├── package.json
├── tsconfig.json
├── scripts/
│   └── bootstrap.sh      # Bootstrap script for new machines
├── src/
│   ├── commands.ts        # /pisync command routing + push/pull/init flows
│   ├── config.ts          # pi-sync.json loading & validation
│   ├── git.ts             # Git operations (status, fetch, pull, push, rebase)
│   ├── inventory.ts       # Three-way file comparison (baseline vs local vs remote)
│   ├── materialize.ts     # Apply repo files to agent (atomic writes, validation)
│   ├── capture.ts         # Import agent changes into repo working tree
│   ├── backup.ts          # Backup & rollback
│   ├── lock.ts            # Concurrency lock (pid-based with staleness detection)
│   ├── security.ts        # Built-in hard deny list & secret scanning
│   ├── doctor.ts          # Environment diagnostics (git, ssh, portability)
│   ├── validate.ts        # File content validation (JSON, conflict markers, portability)
│   ├── state.ts           # Sync state persistence (baseline)
│   ├── packages.ts        # Package reconciliation (settings.json packages[])
│   ├── settings.ts        # Utility functions (deepMerge, deepEqual — legacy)
│   ├── glob.ts            # Custom minimatch glob + hard deny + path filtering
│   └── ui.ts              # Output formatting
└── test/
    ├── config.test.ts
    ├── git.test.ts
    ├── lock.test.ts
    ├── materialize.test.ts
    ├── minimatch.test.ts
    ├── packages.test.ts
    ├── security.test.ts
    └── settings.test.ts
```

### Publishing

```bash
npm run pub        # patch version
npm run pub:minor  # minor version
npm run pub:major  # major version
```

Type checking and tests run automatically before publish. A git tag is created after publish.

---

## License

MIT
