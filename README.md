# pi-git-sync

Sync Pi configuration across machines via GitHub Private Repository.

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [中文文档](./README.zh.md)

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

In Pi, provide your repo URL. pi-git-sync will clone, scaffold config structure, commit and push automatically.

```bash
/pisync init git@github.com:<your-username>/pi-config.git
```

Generated repo structure:

```text
pi-config/
├── .gitignore
├── package.json              # Pi Package manifest
├── pi-sync.json              # Sync configuration
├── extensions/               # Custom extensions
├── skills/                   # Skills
├── prompts/                  # Prompt templates
├── themes/                   # Themes
├── config/
│   ├── settings.shared.json  # Shared settings
│   └── machines/             # Per-machine overrides (optional)
└── files/
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

---

## Commands

| Command | Description |
|---|---|
| `/pisync` | Interactive TUI menu |
| `/pisync status` | Show sync status |
| `/pisync diff` | Show pending changes |
| `/pisync pull` | Pull & apply remote changes |
| `/pisync push` | Commit & push local changes |
| `/pisync apply` | Apply current repo version (offline) |
| `/pisync capture` | Import local config into repo |
| `/pisync doctor` | Run diagnostic checks |
| `/pisync rollback` | Rollback to last backup |

---

## What Gets Synced

| Content | Method |
|---|---|
| Extensions | Loaded directly by Pi from the repo |
| Skills | Loaded directly by Pi from the repo |
| Prompts | Loaded directly by Pi from the repo |
| Themes | Loaded directly by Pi from the repo |
| Shared Settings | Layered merge (shared → platform → machine) |
| `AGENTS.md`, `SYSTEM.md` | Atomic copy to agent directory |
| `keybindings.json` | Atomic copy to agent directory |
| Third-party Packages | Declared and auto-reconciled |

## What Never Gets Synced

`auth.json`, `sessions/`, `trust.json`, `models-store.json`, `npm/`, `git/`, `node_modules/`, `.env`, `*.pem`, `id_rsa` — anything containing credentials or rebuildable artifacts.

## Config Reference (`pi-sync.json`)

```json
{
  "schemaVersion": 1,
  "branch": "main",
  "settings": {
    "source": "config/settings.shared.json",
    "strategy": "managed-keys",
    "preserve": ["lastChangelogVersion", "trackingId", "httpProxy"]
  },
  "files": [
    { "source": "files/AGENTS.md", "target": "AGENTS.md" },
    { "source": "files/SYSTEM.md", "target": "SYSTEM.md", "optional": true },
    { "source": "files/keybindings.json", "target": "keybindings.json", "optional": true }
  ],
  "security": {
    "deny": ["auth.json", "trust.json", "sessions/**", "**/.env"],
    "scanSecretsBeforePush": true
  }
}
```

## Settings Merge Model

```
settings.shared.json  →  settings.<platform>.json  →  machines/<hostname>.json  →  locally preserved fields
```

Priority: `shared < platform < machine < local-only`

## Safety

- Pull uses fast-forward only; stops on divergence
- Automatic secret scanning before push (API keys, tokens, private keys)
- Atomic config writes (temp file → fsync → rename)
- Automatic backup before every apply, with rollback support
- Concurrency lock prevents multiple Pi instances from syncing simultaneously

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
├── index.ts              # Extension entry point
├── package.json
├── tsconfig.json
├── scripts/
│   └── bootstrap.sh      # Bootstrap script for new machines
├── src/
│   ├── commands.ts        # /pisync command routing
│   ├── config.ts          # pi-sync.json parsing
│   ├── git.ts             # Git operations
│   ├── settings.ts        # Settings layered merge
│   ├── materialize.ts     # Atomic file writes
│   ├── capture.ts         # Import local config into repo
│   ├── backup.ts          # Backup & rollback
│   ├── lock.ts            # Concurrency lock
│   ├── security.ts        # Denylist & secret scanning
│   ├── doctor.ts          # Environment diagnostics
│   ├── state.ts           # State persistence
│   ├── packages.ts        # Package reconciliation
│   ├── ui.ts              # Output formatting
│   └── minimatch.ts       # Glob matching
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
