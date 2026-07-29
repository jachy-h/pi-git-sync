# pi-git-sync

Keep the same Pi setup on every machine.

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [中文文档](./README.zh.md)

---

pi-git-sync stores your Pi configuration in one private GitHub repository. It syncs extensions, skills, prompts, themes, settings, and agent instructions.

```text
first machine                                      another machine

Pi configuration ── /pisync ──> private Git repo ── /pisync ──> Pi configuration
```

Run `/pisync` whenever you change your configuration. It protects local work before it updates from the remote repository.

```text
agent files
   │
   ├─ capture and commit local changes
   ├─ fetch the configured branch
   ├─ rebase local commits, or fast-forward remote-only changes
   ├─ apply the resulting configuration to Pi
   └─ push the shared branch and this device's recovery branch
```

If a step fails, syncing stops. A content conflict keeps both sides recoverable instead of silently overwriting a file.

## Get Started

### Requirements

- Pi `0.82.1` or newer (Node.js `>=22.19.0`)
- Git and SSH configured for GitHub

### First machine

1. Create an **empty private** GitHub repository. Do not initialize it with a README.
2. Install the extension:

   ```bash
   pi install npm:@jachy/pi-git-sync
   ```

3. Run `/pisync` in Pi and enter the repository URL.

pi-git-sync creates the repository layout, captures the current configuration, then commits and pushes it. The repository is user data, not a Pi package: do not run `pi install` inside it.

```text
<your-repo>/
├── pi-sync.json       # Sync configuration
└── sync/              # Synced Pi files
    ├── settings.json
    ├── extensions/
    ├── skills/
    ├── prompts/
    └── themes/
```

### Another machine

Install pi-git-sync, run `/pisync`, and enter the same repository URL. Its configuration is applied to that Pi installation.

### Daily use

```bash
/pisync
```

`Esc` cancels an active run and terminates its Git/SSH subprocesses. A run also stops after 60 seconds; `pullTimeoutMs` controls the timeout for each pull, fetch, and rebase operation.

## Commands

| Command | Purpose |
| --- | --- |
| `/pisync` | Set up a machine or run the complete sync |
| `/pisync status` | Show Git and three-way sync status |
| `/pisync diff` | Show pending differences between Pi and the repository |

## What Gets Synced

| Content | Location or behavior |
| --- | --- |
| Extensions, skills, prompts, themes | `sync/extensions/`, `sync/skills/`, `sync/prompts/`, `sync/themes/` |
| `settings.json` | Whole-file copy; no key-level merge |
| `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `keybindings.json` | Copied into the Pi agent directory |
| Third-party packages | Declared in `sync/settings.json` → `packages[]`; new or changed sources need approval |

## What Never Gets Synced

The built-in deny list cannot be overridden:

```text
auth.json  sessions/**  trust.json  models-store.json  npm/**  git/**
node_modules/**  .pi-sync/**  **/.env  **/*.pem  **/id_rsa  **/id_ed25519
```

Hidden files are excluded except `.gitignore`. Symlinks are blocked; pi-git-sync never follows them.

## Configuration (`pi-sync.json`)

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
  "exclude": ["**/.DS_Store", "**/*.tmp", "**/*.log"],
  "delete": "tracked",
  "pullTimeoutMs": 10000,
  "security": { "scanSecretsBeforePush": true }
}
```

| Field | Purpose |
| --- | --- |
| `branch` | The shared branch used by setup and sync |
| `root` | Directory in the repository that holds synced files |
| `include` / `exclude` | Glob allowlist and exclusions under `root` |
| `delete` | `tracked` deletes files removed from the repository; `none` never deletes |
| `pullTimeoutMs` | Per-operation pull, fetch, and rebase timeout in milliseconds |
| `security.scanSecretsBeforePush` | Scan staged files for credentials before push |

## How Conflicts Work

Every sync compares the last synced version, the local Pi files, and the repository files.

```text
                 changed only here
baseline ─────┬────────────────────> continue automatically
              │
              └── same file changed locally and remotely ──> ask before changing it
```

For a real content conflict, choose one of the following:

- Ask the current Pi agent to merge it.
- Abort and merge manually.
- Use local or remote content for only the conflicted paths.

Non-conflicting changes from both sides are retained. Each device also has a persistent recovery branch, so unresolved local changes remain available.

## Safety

- Local changes are captured before remote updates; remote-only changes fast-forward.
- Secrets are scanned before every push.
- Configuration writes are atomic and backed up before apply.
- A lock prevents simultaneous sync runs.
- Path-boundary checks prevent symlink escapes.
- Remote package changes need explicit approval; failed installs attempt rollback.

## Development

### Load locally

```bash
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync
# Then run /reload in Pi.

# Or load temporarily without changing settings.json:
pi -e ./index.ts
```

### Test

```bash
npm install
npm test           # complete suite, including E2E
npm run test:core  # core suite without E2E
npm run test:e2e   # two-device E2E suite
npm run test:smoke # quick glob and UI checks
npm run test:ci    # typecheck, coverage gate, and E2E
npm run typecheck
```

### Upgrade

v0.5 keeps `pi-sync.json` schema v2 and local state schema v3. No repository migration is required: upgrade the extension, run `/pisync status`, then run `/pisync` normally.

See the [upgrade guide](./docs/upgrade.md) for legacy migrations, conflict recovery, and rollback.

### Publish

```bash
npm run pub        # patch version
npm run pub:minor  # minor version
npm run pub:major  # major version
```

## License

MIT
