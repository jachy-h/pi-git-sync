# pi-git-sync

Sync Pi configuration across machines via GitHub Private Repository.

通过 GitHub 私有仓库在多台机器之间同步 Pi 的配置。

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

---

## 使用方式 / Usage

### 前置条件 / Prerequisites

- Pi 已安装 / Pi installed
- Git 和 SSH 已配置（用于 GitHub）/ Git + SSH configured (for GitHub)

### 1. 在 GitHub 创建空私有仓库 / Create an Empty Private Repo on GitHub

创建一个空的私有仓库（例如 `pi-config`），**不要** 勾选 "Initialize with README"。

Create an empty private repo on GitHub (e.g. `pi-config`). Do **NOT** check "Initialize with README".

### 2. 安装 pi-git-sync / Install pi-git-sync

```bash
pi install npm:@jachy/pi-git-sync
```

### 3. 一键初始化 / One-Click Init

在 Pi 中执行，提供你的仓库 URL 即可。pi-git-sync 会自动 clone、生成配置文件结构（scaffold）、提交并推送到远端。

In Pi, just provide your repo URL. pi-git-sync will clone, scaffold config structure, commit and push automatically.

```bash
/pisync init git@github.com:<your-username>/pi-config.git
```

生成的仓库结构 / Generated repo structure:

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

### 4. 导入当前配置 / Capture Current Config

首次使用，把当前本地配置导入仓库：

On first use, import your current local config into the repo:

```bash
/pisync capture
```

然后 commit + push：

Then commit + push:

```bash
/pisync push
```

---

## 命令 / Commands

| 命令 | 说明 |
|---|---|
| `/pisync` | TUI 交互菜单 / Interactive menu |
| `/pisync status` | 查看同步状态 / Show sync status |
| `/pisync diff` | 查看待应用的差异 / Show pending changes |
| `/pisync pull` | 拉取并应用远端更新 / Pull & apply remote changes |
| `/pisync push` | 提交并推送本地变更 / Commit & push local changes |
| `/pisync apply` | 应用当前仓库版本（离线） / Apply current repo version (offline) |
| `/pisync capture` | 将本地配置导入仓库 / Import local config into repo |
| `/pisync doctor` | 诊断环境 / Run diagnostic checks |
| `/pisync rollback` | 回滚到上一个备份 / Rollback to last backup |

`/pisync` 不带参数时弹出 TUI 菜单，可键盘导航选择操作。

---

## 工作原理 / How It Works

### 同步范围 / What Gets Synced

| 内容 | 同步方式 |
|---|---|
| Extensions | Pi 直接从仓库加载 / Loaded directly by Pi |
| Skills | Pi 直接从仓库加载 / Loaded directly by Pi |
| Prompts | Pi 直接从仓库加载 / Loaded directly by Pi |
| Themes | Pi 直接从仓库加载 / Loaded directly by Pi |
| 共享 Settings | 分层合并（shared → platform → machine） |
| `AGENTS.md`, `SYSTEM.md` | 原子复制到 agent 目录 |
| `keybindings.json` | 原子复制到 agent 目录 |
| 第三方 Packages | 同步声明，自动 reconcile |

### 不同步的内容 / What Never Gets Synced

`auth.json`, `sessions/`, `trust.json`, `models-store.json`, `npm/`, `git/`, `node_modules/`, `.env`, `*.pem`, `id_rsa` 等包含认证信息或可重建的安装产物。

### `pi-sync.json` 说明 / Config Reference

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

### Settings 合并模型 / Settings Merge Model

```
settings.shared.json  →  settings.<platform>.json  →  machines/<hostname>.json  →  本机保留字段
```

优先级 / Priority：`shared < platform < machine < local-only`

### 安全措施 / Safety

- Pull 默认仅 fast-forward，分叉时停止并提示
- Push 前自动扫描秘密信息（API Key、Token、私钥等）
- 所有配置写入为原子操作（临时文件 → fsync → rename）
- 每次应用前自动创建备份，支持回滚
- 并发锁防止多个 Pi 实例同时同步

---

## 开发 / Development

### 本地调试 / Local Development

符号链接到 Pi extensions 目录：

```bash
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync
```

修改代码后在 Pi 中执行 `/reload` 即可生效。

或通过 `-e` 临时加载（不写入 settings.json）：

```bash
pi -e ./index.ts
```

### 运行测试 / Run Tests

```bash
npm install
npm test           # 单次运行 / single run
npm run test:watch # 监听模式 / watch mode
npm run typecheck  # 类型检查 / type check
```

### 项目结构 / Project Structure

```text
pi-git-sync/
├── index.ts              # Extension 入口 / entry point
├── package.json
├── tsconfig.json
├── scripts/
│   └── bootstrap.sh      # 新机器引导脚本 / bootstrap script
├── src/
│   ├── commands.ts        # /pisync 命令路由 / command routing
│   ├── config.ts          # pi-sync.json 解析 / config parsing
│   ├── git.ts             # Git 操作 / git operations
│   ├── settings.ts        # Settings 分层合并 / layered merge
│   ├── materialize.ts     # 原子文件应用 / atomic file writes
│   ├── capture.ts         # 本地配置导入仓库 / import to repo
│   ├── backup.ts          # 备份 & 回滚 / backup & rollback
│   ├── lock.ts            # 并发锁 / concurrency lock
│   ├── security.ts        # Denylist & 秘密扫描 / secret scanning
│   ├── doctor.ts          # 环境诊断 / diagnostics
│   ├── state.ts           # 状态持久化 / state persistence
│   ├── packages.ts        # Package reconciliation
│   ├── ui.ts              # 格式化输出 / formatting
│   └── minimatch.ts       # Glob 匹配 / glob matching
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

### 发布 / Publishing

```bash
npm run pub        # patch 版本 / patch version
npm run pub:minor  # minor 版本
npm run pub:major  # major 版本
```

发布前自动运行类型检查和测试。发布后自动创建 git tag。

---

## License

MIT
