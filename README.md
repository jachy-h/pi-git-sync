# pi-git-sync

Sync Pi configuration across machines via a GitHub private repository.

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [中文文档](./README.zh.md)

---

## How It Works

pi-git-sync keeps your Pi configuration in a **private Git repository** and syncs it across all your machines. It uses a **three-way comparison** model based on a sync baseline to detect local changes, remote changes, and conflicts.

**v2 highlights (vs v1):**

- Glob-based include/exclude whitelist — no more manual per-file mappings
- `settings.json` shared as a whole file — simpler, no layered key-merge
- Three-way diff with sync baseline — accurate detection of creates, deletes, and bilateral conflicts
- Full push chain: `capture → commit → fetch → rebase → push → apply`
- `push --continue` for resolving rebase conflicts mid-push
- Config repo is **not** a Pi Package — it\'s a standalone Git repo
- Everything lives under a single `sync/` directory in the repo

---

## Usage

### Prerequisites

- Pi installed
- Git + SSH configured (for GitHub)

### 1. Create an Empty Private Repo on GitHub

Create an empty private repo (e.g. `pi-config`). Do **NOT** check "Initialize with README".

### 2. Install pi-git-sync

```bash
pi install npm:@jachy/pi-git-sync
```

### 3. One-Click Init

In Pi, provide your repo URL. pi-git-sync will clone, scaffold the config structure, commit and push automatically.

```bash
/pisync init git@github.com:<your-username>/pi-config.git
```

Generated repo structure:

```text
pi-config/
├── .gitignore
├── pi-sync.json              # Sync configuration (schema v2)
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

### 4. Capture Current Config

On first use, import your current local config into the repo:

```bash
/pisync capture
```

Then commit + push:

```bash
/pisync push
```

The `push` command combines capture → commit → fetch → rebase → push → apply in one step, with a confirmation prompt after showing you the diff.

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
| Third-party Packages | Declared in `sync/settings.json` → `packages[]`, auto-installed on apply (local-only packages are never auto-removed) |

## What Never Gets Synced

Hard deny list (built-in, not configurable):

`auth.json`, `sessions/**`, `trust.json`, `models-store.json`, `npm/**`, `git/**`, `node_modules/**`, `.pi-sync/**`, `**/.env`, `**/*.pem`, `**/id_rsa`, `**/id_ed25519`

Also: hidden files (except `.gitignore`) and symlinks are skipped.

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
| `schemaVersion` | `2` | — | Must be `2` (v1 configs need migration) |
| `branch` | `string` | `"main"` | Git branch to sync |
| `root` | `string` | `"sync"` | Root directory inside the repo for synced content |
| `include` | `string[]` | — | Glob whitelist (relative to `root`). Supports `*`, `**`, `?` |
| `exclude` | `string[]` | `[]` | Glob patterns to exclude (lower priority than built-in hard deny) |
| `delete` | `"tracked"` \| `"none"` | `"tracked"` | `"tracked"`: delete agent files when removed from repo. `"none"`: never delete |
| `security.scanSecretsBeforePush` | `boolean` | `true` | Scan staged files for secrets (API keys, tokens, private keys) before pushing |

---

## Sync Model (v2)

### Three-Way Comparison

Every sync operation compares three states:

```
B = Baseline (last synced commit hash)  — stored in .pi-sync/state.json
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

```
capture (agent → repo working tree)
  → commit
  → fetch origin
  → rebase onto origin/main
  → push
  → apply (new HEAD → agent)
```

If a rebase conflict occurs, the push pauses. Resolve conflicts with standard Git tools, then:

```bash
/pisync push --continue
```

### Pull Flow

```
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
- Automatic **backup** before every apply, with **rollback** support
- **Concurrency lock** prevents multiple Pi instances from syncing simultaneously
- **Built-in hard deny list** prevents syncing credentials (not user-overridable)
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
npm test           # single run
npm run test:watch # watch mode
npm run typecheck  # type check
```

### Project Structure

```text
pi-git-sync/
├── index.ts              # Extension entry point (v2)
├── package.json
├── tsconfig.json
├── scripts/
│   └── bootstrap.sh      # Bootstrap script for new machines
├── src/
│   ├── commands.ts        # /pisync command routing + push/pull/init flows
│   ├── config.ts          # pi-sync.json loading & validation (schema v2)
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
