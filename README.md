# pi-git-sync

Keep the same Pi setup on every machine.

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [中文文档](./README.zh.md)

pi-git-sync stores Pi configuration in a private Git repository and synchronizes it across machines.

```text
Machine A ── /pisync ──> Private Git repo <── /pisync ── Machine B
```

## 1. Quick Start

### Requirements and setup

- Pi `0.82.1` or newer (Node.js `>=22.19.0`)
- Git installed, with SSH or HTTPS credentials configured for GitHub

On the first machine:

1. Create an **empty private** GitHub repository. Do not initialize it with a README.
2. Install the extension:

   ```bash
   pi install npm:@jachy/pi-git-sync
   ```

3. Run `/pisync` and enter the repository URL.

On another machine, install the extension and run `/pisync` with the same URL.

---

😄 **The steps above complete multi-device sync. What follows is only a more detailed explanation and can be skipped.**

---

### Daily use

| Command | Purpose |
| --- | --- |
| `/pisync` | Set up a machine or run a complete sync |
| `/pisync status` | Show Git and three-way sync status |
| `/pisync diff` | Preview pending differences |

Run `/pisync` after changing Pi configuration. Press `Esc` to cancel an active run and terminate its Git/SSH subprocesses.

### Sync scope

| Content | Behavior |
| --- | --- |
| Extensions, skills, prompts, themes | Synced from their matching directories under `sync/` |
| `settings.json` | Whole-file sync; machine-local `file:` packages stay on that device |
| `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `keybindings.json` | Copied into the Pi agent directory |
| Third-party packages | Declared in `settings.json`; new or changed sources require approval |

These paths are always blocked:

```text
auth.json  sessions/**  trust.json  models-store.json  npm/**  git/**
node_modules/**  **/node_modules/**  .pi-sync/**  **/.env  **/*.pem
**/id_rsa  **/id_ed25519
```

Hidden files are excluded except `.gitignore`. Symlinks are never followed.

## 2. Learn More

### Synchronization model

```text
agent files
   │
   ├─ capture and commit local changes
   ├─ fetch the configured branch
   ├─ rebase local commits, or fast-forward remote-only changes
   ├─ apply the resulting configuration to Pi
   └─ push the shared branch and this device's recovery branch
```

A failed step stops the run. Files are never silently overwritten when both sides changed.

### Repository and configuration

The repository is cloned locally to:

```text
~/.pi/config-repo/
├── pi-sync.json       # Sync configuration
└── sync/              # Synced Pi files
    ├── settings.json
    ├── extensions/
    ├── skills/
    ├── prompts/
    └── themes/
```

Default `~/.pi/config-repo/pi-sync.json`:

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
    "**/*.log",
    "extensions/**/.cache/**",
    "extensions/**/cache/**",
    "extensions/**/coverage/**",
    "extensions/**/logs/**",
    "extensions/**/temp/**",
    "extensions/**/tmp/**"
  ],
  "delete": "tracked",
  "pullTimeoutMs": 10000,
  "security": { "scanSecretsBeforePush": true }
}
```

- Filtering priority: built-in hard deny > `exclude` > `include`.
- `delete: "tracked"` propagates deletion only for managed files; `"none"` disables deletion.
- `pullTimeoutMs` controls each pull, fetch, and rebase operation. A complete `/pisync` run stops after 60 seconds.
- Secret scanning is enabled by default. Built-in hard deny remains active if scanning is disabled.

### Conflicts and safety

```text
                 changed on one side ──> continue automatically
baseline ────────┤
                 changed on both sides ─> ask before applying
```

For a content conflict, ask the current Pi agent to merge, choose local or remote content for the conflicted paths, or stop and merge manually. Non-conflicting changes and each device's recovery branch remain available.

Additional safeguards include atomic writes, pre-apply backups, operation locking, path-boundary checks, package approval, and rollback attempts after failed installs.

### Development

```bash
# Load locally, then run /reload in Pi
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync

# Or load temporarily
pi -e ./index.ts
```

```bash
npm install
npm test           # complete suite, including E2E
npm run test:core  # core suite without E2E
npm run test:e2e   # two-device E2E suite
npm run test:smoke # quick glob and UI checks
npm run test:ci    # typecheck, coverage gate, and E2E
```

After upgrading, run `/pisync status`, then `/pisync`. See the [upgrade guide](./docs/upgrade.md) for migrations, conflict recovery, and rollback.

## License

MIT
