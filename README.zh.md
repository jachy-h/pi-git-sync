# pi-git-sync

让每台机器使用相同的 Pi 配置。

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [English](./README.md)

---

pi-git-sync 将 Pi 配置保存在一个私有 GitHub 仓库中，可同步扩展、技能、提示模板、主题、设置和 agent 指令。

```text
第一台机器                                      另一台机器

Pi 配置 ── /pisync ──> 私有 Git 仓库 ── /pisync ──> Pi 配置
```

每次修改配置后执行 `/pisync`。它会先保护本机改动，再从远端更新。

```text
agent 文件
   │
   ├─ 捕获并提交本机改动
   ├─ 获取配置分支
   ├─ 对本地提交 rebase，或对仅远端改动 fast-forward
   ├─ 将结果应用到 Pi
   └─ 推送共享分支与本机恢复分支
```

任一步失败都会停止同步。内容冲突会保留双方改动，不会静默覆盖文件。

## 开始使用

### 前置要求

- Pi `0.82.1` 或更高版本（Node.js `>=22.19.0`）
- 已配置 Git 和 GitHub SSH

### 第一台机器

1. 在 GitHub 创建一个**空的私有**仓库，不要初始化 README。
2. 安装扩展：

   ```bash
   pi install npm:@jachy/pi-git-sync
   ```

3. 在 Pi 中运行 `/pisync`，按提示输入仓库 URL。

pi-git-sync 会创建仓库结构、捕获当前配置，然后提交并推送。配置仓库是用户数据，不是 Pi Package；不要在其中执行 `pi install`。

```text
<你的仓库>/
├── pi-sync.json       # 同步配置
└── sync/              # 已同步的 Pi 文件
    ├── settings.json
    ├── extensions/
    ├── skills/
    ├── prompts/
    └── themes/
```

### 另一台机器

安装 pi-git-sync 后运行 `/pisync`，输入同一个仓库 URL。仓库中的配置会应用到这台 Pi。

### 日常使用

```bash
/pisync
```

按 `Esc` 可取消正在运行的同步，并终止其 Git/SSH 子进程。一次同步最多运行 60 秒；`pullTimeoutMs` 控制每个 pull、fetch 和 rebase 操作的超时时间。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/pisync` | 设置机器或执行完整同步 |
| `/pisync status` | 查看 Git 与三方同步状态 |
| `/pisync diff` | 查看 Pi 与仓库之间的待处理差异 |

## 同步内容

| 内容 | 位置或行为 |
| --- | --- |
| Extensions、Skills、Prompts、Themes | `sync/extensions/`、`sync/skills/`、`sync/prompts/`、`sync/themes/` |
| `settings.json` | 整文件复制；不做 key 级合并 |
| `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`keybindings.json` | 复制到 Pi agent 目录 |
| 第三方 Packages | 在 `sync/settings.json` → `packages[]` 中声明；新增或变更 source 必须审批 |

## 永不同步的内容

以下内置 deny list 不可覆盖：

```text
auth.json  sessions/**  trust.json  models-store.json  npm/**  git/**
node_modules/**  **/node_modules/**  .pi-sync/**  **/.env  **/*.pem
**/id_rsa  **/id_ed25519
```

隐藏文件（`.gitignore` 除外）会被排除。符号链接会被阻止；pi-git-sync 不会跟随符号链接。

## 配置（`pi-sync.json`）

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

| 字段 | 用途 |
| --- | --- |
| `branch` | setup 与同步使用的共享分支 |
| `root` | 仓库中存放同步文件的目录 |
| `include` / `exclude` | `root` 下的 Glob 白名单与排除规则 |
| `delete` | `tracked`：仓库删除时同步删除；`none`：永不删除 |
| `pullTimeoutMs` | 每个 pull、fetch 和 rebase 操作的超时（毫秒） |
| `security.scanSecretsBeforePush` | 推送前扫描暂存文件中的凭据 |

## 冲突处理

每次同步都会比较上次同步版本、本机 Pi 文件和仓库文件。

```text
                 仅一侧修改
基线 ────────┬────────────────────> 自动继续
             │
             └── 本机与远端修改同一文件 ──> 询问后再处理
```

发生真实内容冲突时，可选择：

- 让当前 Pi agent 协助合并；
- 中止后手动合并；
- 仅对冲突路径使用本机或远端内容。

双方的非冲突改动都会保留。每台设备还有一个持久恢复分支，因此未解决的本机改动仍可恢复。

## 安全措施

- 先捕获本机改动，再更新远端；仅远端改动使用 fast-forward。
- 每次推送前扫描敏感信息。
- 配置写入是原子的，apply 前会备份。
- 锁会阻止多个同步同时运行。
- 路径边界检查会阻止符号链接越界。
- 远端 package 变更必须明确审批；安装失败会尝试回滚。

## 开发

### 本地加载

```bash
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync
# 然后在 Pi 中执行 /reload。

# 或临时加载，不修改 settings.json：
pi -e ./index.ts
```

### 测试

```bash
npm install
npm test           # 完整测试套件，含 E2E
npm run test:core  # 不含 E2E 的核心测试
npm run test:e2e   # 双设备 E2E 测试
npm run test:smoke # 快速 glob 与 UI 检查
npm run test:ci    # 类型检查、覆盖率门禁和 E2E
npm run typecheck
```

### 升级

v0.6 保持 `pi-sync.json` schema v2 和本地 state schema v3，不需要迁移仓库：升级扩展后，运行 `/pisync status`，再正常运行 `/pisync` 即可。

旧版本迁移、冲突恢复和回滚说明见[升级指南](./docs/upgrade.md)。

### 发布

```bash
npm run pub        # patch 版本
npm run pub:minor  # minor 版本
npm run pub:major  # major 版本
```

## License

MIT
