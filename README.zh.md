# pi-git-sync

无论在哪里工作，都能带着你的 Pi 配置。

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [English](./README.md)

---

## 随身携带你的配置

连接一个私有 GitHub 仓库后，它就会在不同机器之间承载你的 Pi 配置。扩展、技能、提示模板、主题、设置和 agent 指令都会在同一个位置。

第一台机器会捕获你现有的配置。换到另一台机器时，将 pi-git-sync 指向同一个仓库即可继续使用。
在任意设备执行 `/pisync` 完成完整同步：先拉取远端变更，再捕获并推送本地变更。

在后台，pi-git-sync 会将同步内容保存在 `sync/` 下，比对上次同步状态、本地变更和远端变更；
同一文件在两个位置都有修改时，它会停下来等待你确认。

---

## 开始使用

### 使用前准备

- Pi `0.82.1` 或更高版本（Node.js `>=22.19.0`）
- Git 和 SSH 已配置（用于 GitHub）

### 1. 创建私有仓库

在 GitHub 创建一个空的私有仓库（名称任选），不要勾选 **Initialize with README**。

### 2. 在第一台机器安装 pi-git-sync

```bash
pi install npm:@jachy/pi-git-sync
```

配置仓库是用户数据，不是 Pi Package。不要对配置仓库本身执行 `pi install`。

### 3. 连接第一台机器

在 Pi 中执行 `/pisync`，按提示输入仓库 URL。对于空仓库，pi-git-sync 会以当前机器作为起点：
创建配置结构、捕获现有本地配置（包括 `settings.json` 及其中的 `packages[]`），然后提交并推送到远端。

生成的仓库结构：

```text
<your-repo>/
├── .gitignore
├── pi-sync.json              # 同步配置
└── sync/                     # 所有同步内容在此
    ├── settings.json          # 共享设置（完整文件）
    ├── AGENTS.md              # （可选）
    ├── SYSTEM.md              # （可选）
    ├── APPEND_SYSTEM.md       # （可选）
    ├── keybindings.json       # （可选）
    ├── extensions/            # 自定义扩展
    ├── skills/                # 技能
    ├── prompts/               # 提示模板
    └── themes/                # 主题
```

### 在新机器上继续使用

安装 pi-git-sync 后，执行 `/pisync` 并按提示输入已有仓库 URL。
pi-git-sync 会获取仓库，并将其中的配置应用到这台 Pi 安装。

### 分享后续变更

修改配置后，执行：

```bash
/pisync
```

该命令会先拉取远端变更，再捕获并推送本地变更。执行期间状态栏会持续显示
已用时间；按下 `Esc` 可立即取消并终止当前子进程。单次有效同步执行达到 60
秒时也会自动停止。若旧版本留下默认 settings 模板且同步基线为空，`/pisync`
会识别并校准该状态，无需复制文件。

---

## 命令

| 命令 | 说明 |
| --- | --- |
| `/pisync` | 首次 setup 或执行完整的先拉取后推送同步 |
| `/pisync status` | 显示详细同步状态（三方比较 + Git 信息） |
| `/pisync diff` | 显示 agent 与仓库之间的待处理变更 |

---

## 同步范围

| 内容 | 同步方式 |
| --- | --- |
| Extensions | 从 `sync/extensions/` 复制到 agent 目录 |
| Skills | 从 `sync/skills/` 复制到 agent 目录 |
| Prompts | 从 `sync/prompts/` 复制到 agent 目录 |
| Themes | 从 `sync/themes/` 复制到 agent 目录 |
| `settings.json` | 整文件复制（不做 key 级别合并） |
| `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md` | 复制到 agent 目录 |
| `keybindings.json` | 复制到 agent 目录 |
| 第三方 Packages | 在 `sync/settings.json` → `packages[]` 中声明；新增或变更 source 必须审批后安装（不会自动卸载本地 package） |

## 不同步的内容

内置 hard deny 列表（不可配置）：

`auth.json`、`sessions/**`、`trust.json`、`models-store.json`、`npm/**`、`git/**`、`node_modules/**`、`.pi-sync/**`、`**/.env`、`**/*.pem`、`**/id_rsa`、`**/id_ed25519`

此外，隐藏文件（`.gitignore` 除外）会被排除。符号链接及其中间路径会直接阻断，并不会被跟随或静默跳过。

---

## 配置说明（`pi-sync.json`）

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
  "pullTimeoutMs": 10000,
  "security": {
    "scanSecretsBeforePush": true
  }
}
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | `2` | — | 配置 schema 版本（当前为 `2`） |
| `branch` | `string` | `"main"` | setup、status、同步和 rebase 统一使用的唯一 Git 分支 |
| `root` | `string` | `"sync"` | 仓库中同步内容的根目录 |
| `include` | `string[]` | — | Glob 白名单（相对于 `root`）。支持 `*`、`**`、`?` |
| `exclude` | `string[]` | `[]` | Glob 排除列表（优先级低于内置 hard deny） |
| `delete` | `"tracked"` \| `"none"` | `"tracked"` | `"tracked"`：仓库删除时同步删除 agent 文件。`"none"`：永不删除 |
| `pullTimeoutMs` | `number` | `10000` | pull/fetch/rebase Git 操作超时时间（毫秒）；超时会终止整个 Git/SSH 进程树、停止本次同步并恢复 Pi 输入 |
| `security.scanSecretsBeforePush` | `boolean` | `true` | 推送前扫描敏感信息（API Key、Token、私钥等） |

---

## 同步模型

### 三方比较

每次同步操作比较三个状态：

```text
B = 基线（上次同步的 commit 哈希）— 存储在 `<config-repo>/.pi-sync/state.json`（Git ignored）
L = 本地（当前 agent 文件）
R = 远端（当前仓库 sync/ 文件）
```

这样可以精准检测：

| 场景 | 分类 | 操作 |
| --- | --- | --- |
| 只有你修改了文件 | `local_only` | push 时捕获 |
| 只有远端修改了文件 | `remote_only` | pull 时应用 |
| 双方对同一文件做了不同修改 | `both_modified` | **阻止** — 手动解决冲突 |
| 你创建了新文件 | `local_created` | push 时捕获 |
| 远端创建了新文件 | `remote_created` | pull 时应用 |
| 你删除了已管理的文件 | `local_deleted` | push 时捕获 |
| 远端删除了已管理的文件 | `remote_deleted` | pull 时应用（若 `delete: "tracked"`） |
| 双方做了相同的修改 | `converged` | 更新基线，无冲突 |

### Push 流程

```text
capture（agent → 仓库工作树）
  → commit
  → fetch origin
  → rebase 到 origin/<配置分支>
  → push <配置分支>
  → push 当前设备快照分支
  → apply（新 HEAD → agent）
```

每台设备都有一个持久、唯一的远端快照分支：`pisync-device/<主机名>-<UUID>`。主机名不是唯一标识，UUID 仅保存在本机 `<config-repo>/.pi-sync/state.json`；该目录被 Git 忽略，不会参与同步。因此工具不会扫描远端分支后猜测“唯一设备分支”。

发生冲突时，pi-git-sync 会把当前设备的改动推送到该设备分支，并将配置分支
恢复到远端 `main`（或 `pi-sync.json.branch`）。只要 Git 能无冲突合并，工具会
自动合并该设备分支并推送结果；仅真正的内容冲突或共享分支被并发更新时才需要
手动处理：

```bash
cd <同步仓库目录>
git fetch origin
git switch main
git merge origin/pisync-device/<主机名>-<UUID>
# 解决冲突后
git add <文件>
git commit
git push origin main
```

### Pull 流程

```text
fetch origin
  → 检查是否有未捕获的本地变更（如有则阻止）
  → 仅 fast-forward（分叉时阻止）
  → apply（新 HEAD → agent）
```

---

## 安全措施

- Pull 默认**仅 fast-forward**，分叉时停止
- **双边冲突检测** — 可快进或无冲突合并时自动合入当前设备分支；仅内容冲突
  或共享分支并发更新需要手动解决
- Push 前自动**扫描敏感信息**（API Key、Token、私钥等）
- **原子配置写入**（临时文件 → rename）
- 每次 apply 前自动**备份**，失败时 fail-closed 并支持**回滚**
- **并发锁**防止多个 Pi 实例同时同步
- **内置 hard deny 列表**防止同步凭证（用户不可覆盖）
- 仓库和 agent 的**路径边界检查**阻断 symlink 越界
- 远端新增或变更 package 必须明确审批；安装失败会尝试回滚 package
- Settings.json **可移植性校验** — 对绝对路径和机器专属内容发出警告

---

## 开发

### 本地调试

符号链接到 Pi extensions 目录：

```bash
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync
```

修改代码后在 Pi 中执行 `/reload` 即可生效。

或通过 `-e` 临时加载（不写入 settings.json）：

```bash
pi -e ./index.ts
```

### 运行测试

```bash
npm install
npm test           # 单元/集成测试
npm run test:ci    # 类型检查 + 覆盖率 + E2E
npm run test:watch # 监听模式
npm run typecheck  # 类型检查
npm audit --omit=dev --audit-level=high
npm audit --audit-level=high
```

### 升级说明

从 `0.2.x`（或更早的兼容 state）升级时保留现有配置仓库，执行 `/pisync`。本地同步 state 会在备份旧文件后从
schema v2 迁移到 v3。本地与仓库一致的文件会自动收敛；冲突文件会保留现状并报告，不会自动选边。

详见[完整升级指南](./docs/upgrade.md)。

### 项目结构

```text
pi-git-sync/
├── index.ts              # Extension 入口
├── package.json
├── tsconfig.json
├── scripts/
│   └── bootstrap.sh      # 新机器引导脚本
├── src/
│   ├── commands.ts        # /pisync 命令路由 + 统一同步流程
│   ├── config.ts          # pi-sync.json 加载与校验
│   ├── git.ts             # Git 操作（status、fetch、fast-forward、push、rebase）
│   ├── inventory.ts       # 三方文件比较（基线 vs 本地 vs 远端）
│   ├── materialize.ts     # 将仓库文件应用到 agent（原子写入、校验）
│   ├── capture.ts         # 将 agent 变更导入仓库工作树
│   ├── backup.ts          # 备份与回滚
│   ├── lock.ts            # 并发锁（基于 pid，可检测过期）
│   ├── security.ts        # 内置 hard deny 列表与敏感信息扫描
│   ├── validate.ts        # 文件内容校验（JSON、冲突标记、可移植性）
│   ├── state.ts           # 同步状态持久化（基线）
│   ├── packages.ts        # Package reconciliation（settings.json packages[]）
│   ├── settings.ts        # 工具函数（deepMerge、deepEqual — 遗留）
│   ├── glob.ts            # 自定义 minimatch glob + hard deny + 路径过滤
│   └── ui.ts              # 输出格式化
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

### 发布

```bash
npm run pub        # patch 版本
npm run pub:minor  # minor 版本
npm run pub:major  # major 版本
```

发布前自动运行类型检查和测试。发布后自动创建 git tag。

---

## License

MIT
