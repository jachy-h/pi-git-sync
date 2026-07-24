# pi-git-sync 设计方案

通过 GitHub Private Repository 在多台机器之间同步 Pi 的配置、Skills、Extensions、Prompt Templates、Themes 等资源。

> 当前阶段仅包含设计方案，尚未实现。

## 1. 设计目标

- 使用 GitHub Private Repo 作为配置的唯一数据源。
- 尽量复用 Pi 原生 Package 和资源加载机制。
- 支持同步 Extensions、Skills、Prompts、Themes 和共享 Settings。
- 支持 `AGENTS.md`、`SYSTEM.md`、`keybindings.json` 等全局文件。
- 不把认证信息、会话、缓存和安装产物提交到 Git。
- 同步前展示差异，发生冲突时安全停止。
- 配置写入应当是原子的，并且可以回滚。
- 支持 macOS、Linux 和不同机器的配置覆盖。

## 2. 总体架构

采用：

> **GitHub Private Repo + Pi Package + 同步 Extension**

私人仓库本身是一个标准 Pi Package。Pi 直接从仓库加载：

- Extensions
- Skills
- Prompt Templates
- Themes

`pi-git-sync` Extension 负责 Pi Package 无法直接管理的部分：

- `settings.json` 的安全合并
- `AGENTS.md`、`SYSTEM.md` 等全局文件
- Git pull、push 和冲突检测
- 多平台、多机器配置覆盖
- 配置校验、敏感信息扫描、备份及回滚
- 同步完成后的 Pi Runtime Reload

不应简单地把整个 `~/.pi/agent` 加入 Git，因为该目录可能包含认证信息、会话、缓存、依赖和安装产物。

## 3. 推荐仓库结构

```text
pi-config/
├── package.json
├── package-lock.json
├── pi-sync.json
├── extensions/
│   ├── pi-git-sync/
│   │   ├── index.ts
│   │   └── src/
│   └── other-extension.ts
├── skills/
│   ├── skill-a/
│   │   └── SKILL.md
│   └── skill-b/
│       ├── SKILL.md
│       └── scripts/
├── prompts/
│   └── review.md
├── themes/
│   └── custom.json
├── config/
│   ├── settings.shared.json
│   ├── settings.macos.json
│   ├── settings.linux.json
│   └── machines/
│       └── my-mac.json
├── files/
│   ├── AGENTS.md
│   ├── SYSTEM.md
│   ├── APPEND_SYSTEM.md
│   ├── keybindings.json
│   └── zentui.json
├── scripts/
│   └── bootstrap.sh
└── .gitignore
```

`package.json` 示例：

```json
{
  "name": "personal-pi-config",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Extensions、Skills、Prompts 和 Themes 直接由 Pi Package 机制加载，不需要复制到 `~/.pi/agent`。

## 4. 安装与引导

### 4.1 新机器首次安装

推荐把仓库克隆到独立工作区，而不是 Pi 管理的 `agent/git/` 目录：

```bash
git clone git@github.com:<user>/pi-config.git ~/.pi/config-repo
pi install ~/.pi/config-repo
```

然后在 Pi 中执行：

```text
/pisync apply
```

使用独立工作区有以下优点：

- 仓库可以正常编辑、提交和推送。
- 不会受到 `pi update` 对 package clone 执行 reset/clean 的影响。
- Pi 仍可将其作为本地 Package 加载。
- 同步插件本身也可以随仓库更新。

仓库中的 `scripts/bootstrap.sh` 最终应自动完成：

1. 检查 `git`、`pi` 和 SSH 环境。
2. Clone 或更新配置仓库。
3. 执行 `pi install <repo-path>`。
4. 首次应用共享配置。
5. 输出认证配置等未同步项目的设置提示。

## 5. 同步范围

### 5.1 默认同步

| 内容 | 同步方式 |
|---|---|
| Extensions | 直接从仓库加载 |
| Skills | 直接从仓库加载 |
| Prompts | 直接从仓库加载 |
| Themes | 直接从仓库加载 |
| 共享 Settings | 按字段合并 |
| `AGENTS.md` / `SYSTEM.md` | 原子复制或受控符号链接 |
| `keybindings.json` | 原子复制 |
| 第三方 Package 声明 | 同步声明，再由 Pi 安装或更新 |
| 其他插件配置 | 由 `pi-sync.json` 显式声明 |

### 5.2 默认禁止同步

```text
auth.json
sessions/
trust.json
models-store.json
npm/
git/
node_modules/
.env
*.pem
id_rsa
临时文件和日志
```

原因：

- `auth.json` 可能包含 OAuth 或 API 认证信息。
- `sessions/` 可能包含代码、对话及其他隐私数据。
- `npm/`、`git/` 和 `node_modules/` 是可重建的安装产物。
- GitHub Private Repo 只是限制访问，不等于秘密加密存储。

如果以后确实需要跨设备同步秘密，可以增加可选的 `age` 或 `sops` 加密模块，但不纳入 MVP。

## 6. Settings 合并模型

不能直接用远端文件覆盖 `~/.pi/agent/settings.json`，应采用分层合并：

```text
当前本地 settings
    ↓
settings.shared.json
    ↓
settings.<platform>.json
    ↓
machines/<hostname>.json
    ↓
本机保留字段
```

配置优先级：

```text
shared < platform < machine < local-only
```

共享配置示例：

```json
{
  "theme": "dark",
  "defaultProvider": "openai-codex",
  "defaultModel": "example-model",
  "defaultThinkingLevel": "medium",
  "enabledModels": ["gpt-*", "claude-*"],
  "compaction": {
    "enabled": true
  }
}
```

以下字段默认视为本机字段，不从远端覆盖：

```text
lastChangelogVersion
trackingId
httpProxy
sessionDir
externalEditor
npmCommand
机器相关绝对路径
认证相关字段
```

第三方 Package 只同步来源声明：

```json
{
  "packages": [
    "npm:some-pi-package",
    "git:github.com/user/private-package@v1"
  ]
}
```

不保存实际的 `npm/`、`git/` 或 `node_modules/` 内容。

## 7. `pi-sync.json`

建议使用显式 manifest 定义同步行为：

```json
{
  "schemaVersion": 1,
  "branch": "main",
  "settings": {
    "source": "config/settings.shared.json",
    "strategy": "managed-keys",
    "preserve": [
      "lastChangelogVersion",
      "trackingId",
      "httpProxy",
      "sessionDir",
      "externalEditor",
      "npmCommand"
    ]
  },
  "files": [
    {
      "source": "files/AGENTS.md",
      "target": "AGENTS.md"
    },
    {
      "source": "files/SYSTEM.md",
      "target": "SYSTEM.md",
      "optional": true
    },
    {
      "source": "files/keybindings.json",
      "target": "keybindings.json",
      "optional": true
    },
    {
      "source": "files/zentui.json",
      "target": "zentui.json",
      "optional": true
    }
  ],
  "security": {
    "deny": [
      "auth.json",
      "trust.json",
      "sessions/**",
      "models-store.json",
      "**/.env",
      "**/*.pem",
      "**/id_rsa"
    ],
    "scanSecretsBeforePush": true
  }
}
```

所有 `target` 都相对于 `PI_CODING_AGENT_DIR`，不能硬编码 `~/.pi/agent`。

## 8. 命令设计

统一注册 `/pisync` 命令：

```text
/pisync
/pisync status
/pisync diff
/pisync pull
/pisync push
/pisync apply
/pisync capture
/pisync doctor
/pisync rollback
```

不带参数的 `/pisync` 在 TUI 中显示操作菜单。

### 8.1 `/pisync status`

显示：

- 当前分支和 commit。
- 本地相对远端领先或落后的提交数。
- 仓库是否存在未提交修改。
- 本地配置是否偏离仓库。
- 上次同步的时间和结果。
- 是否存在待应用的 Settings 或文件变化。

### 8.2 `/pisync diff`

按类别展示：

```text
Git 仓库变化
Settings 将修改的字段
将创建、更新或删除的配置文件
第三方 Packages 变化
敏感文件和疑似秘密警告
```

### 8.3 `/pisync pull`

流程：

1. 获取同步锁。
2. 检查仓库是否有未提交修改。
3. 执行 `git fetch`。
4. 检查本地和远端提交关系。
5. 默认只允许 fast-forward。
6. 校验拉取后的仓库内容。
7. 备份当前本地配置。
8. 原子应用新配置。
9. 安装或 reconcile 缺失的第三方 Packages。
10. 调用 `ctx.reload()`。

发生分支分叉时默认停止，不自动执行强制 reset。

### 8.4 `/pisync push`

流程：

1. 捕获允许同步的本地配置。
2. 执行敏感信息扫描。
3. 展示完整 diff。
4. 请求用户确认。
5. 创建 commit。
6. 执行 `git pull --rebase`。
7. Push 到远端。

Push、commit 等远端副作用不应默认暴露为 LLM Tool，应由用户显式执行 Slash Command。

### 8.5 `/pisync apply`

不访问网络，只把当前仓库版本应用到 Pi。

适用于：

- 首次安装。
- 手动解决 Git 冲突后重新应用。
- 切换到指定 commit 后恢复配置。

### 8.6 `/pisync capture`

把本机允许同步的内容导入仓库，例如：

```text
~/.pi/agent/extensions/custom.ts
~/.pi/agent/zentui.json
~/.pi/agent/AGENTS.md
```

该命令主要用于首次迁移。迁移完成后，Extensions、Skills 等资源应直接在仓库中维护，避免双向目录复制。

### 8.7 `/pisync doctor`

检查：

- Git 和 SSH 是否可用。
- Origin 是否为预期仓库。
- JSON 格式是否正确。
- Skill frontmatter 是否有效。
- 是否存在 Skill 名称冲突。
- Extension 和 Package manifest 是否有效。
- 是否存在机器相关绝对路径。
- 是否存在失效或逃逸仓库根目录的符号链接。
- 是否存在疑似 Token、API Key 或私钥。
- 文件权限是否安全。
- 仓库路径是否已正确加入 Pi Settings。

### 8.8 `/pisync rollback`

支持恢复：

- 上一次成功应用前的本地配置备份。
- 指定 Git commit 对应的配置。

Rollback 前也要创建当前状态备份。

## 9. Git 冲突策略

默认行为：

| 状态 | 行为 |
|---|---|
| 无本地修改且远端领先 | Fast-forward pull |
| 有未提交修改 | 停止并提示 |
| 仅本地领先 | 允许 push |
| 本地和远端均有提交 | 停止，由用户选择 rebase |
| 存在 merge/rebase 冲突 | 保留冲突现场，不应用配置 |

插件永不默认执行：

```text
git reset --hard
git clean -fd
git push --force
```

如未来提供这些能力，必须通过单独的危险操作确认流程。

## 10. 数据安全

### 10.1 原子写入

所有本地配置应用采用：

```text
解析和校验
→ 写入同目录临时文件
→ 设置权限
→ fsync
→ rename
→ 保留备份
```

备份目录：

```text
~/.pi/agent/.pi-sync/backups/<timestamp>/
```

### 10.2 并发控制

使用锁文件：

```text
~/.pi/agent/.pi-sync/sync.lock
```

锁信息至少包含：

```json
{
  "pid": 12345,
  "hostname": "my-host",
  "startedAt": "2026-01-01T00:00:00Z",
  "operation": "pull"
}
```

插件需要识别失效锁，但删除失效锁前应进行 PID 和时间检查。

### 10.3 Reload 生命周期

同步完成后使用 Pi 原生 Reload：

```typescript
await ctx.reload();
return;
```

`ctx.reload()` 会重新加载 Extensions、Skills、Prompts、Themes 和上下文文件。由于插件代码本身可能刚被更新，Reload 后不能继续使用旧 Extension 实例或旧 Context。

## 11. 自动同步策略

MVP 默认只支持手动同步。

不建议默认开启：

- 启动时自动 pull。
- 退出时自动 commit 或 push。
- 检测变化后自动覆盖配置。
- 自动解决 Git 冲突。

后续可以提供温和模式：

```json
{
  "auto": {
    "checkOnStartup": true,
    "pullOnStartup": false,
    "pushOnShutdown": false
  }
}
```

`checkOnStartup` 只执行远端状态检查，并在状态栏提示：

```text
pi-sync: remote +2
```

它不应自动修改文件或 Reload Runtime。

Extension factory 中不能启动长期计时器、Watcher 或后台进程。远端检查应在 `session_start` 中按需执行，并在 `session_shutdown` 中清理资源。

## 12. 当前配置迁移建议

首次迁移可以处理：

- 将 `settings.json` 拆分为共享字段和本机字段。
- 将自定义 Extensions 移入仓库的 `extensions/`。
- 将 `zentui.json` 等显式允许的插件配置移入 `files/`。
- 将当前 Package 来源声明写入共享 Settings。

必须排除：

- `auth.json`
- `models-store.json`
- `sessions/`
- `npm/node_modules`
- 可重新安装的二进制文件

迁移完成后，应尽量直接编辑仓库中的资源，而不是同时维护仓库和 `~/.pi/agent` 中的两个副本。

## 13. 内部模块划分

建议实现时拆分为以下模块：

```text
extensions/pi-git-sync/
├── index.ts                 # Extension 注册和生命周期
└── src/
    ├── commands.ts          # /pisync 命令路由
    ├── config.ts            # pi-sync.json 读取和校验
    ├── git.ts               # Git 状态、fetch、pull、push
    ├── settings.ts          # Settings 分层和 managed-key merge
    ├── materialize.ts       # 文件原子应用
    ├── capture.ts           # 本地配置导入仓库
    ├── backup.ts            # 备份和回滚
    ├── lock.ts              # 并发锁
    ├── security.ts          # denylist 和 secret scanning
    ├── doctor.ts            # 环境及配置诊断
    ├── state.ts             # 上次同步状态
    └── ui.ts                # TUI 提示和 diff 展示
```

核心同步逻辑应独立于 Pi UI，方便后续复用为 `pisync` CLI 和单元测试。

## 14. 状态文件

本地运行状态保存在：

```text
~/.pi/agent/.pi-sync/state.json
```

示例：

```json
{
  "schemaVersion": 1,
  "repoPath": "/Users/example/.pi/config-repo",
  "lastAppliedCommit": "abc123",
  "lastAppliedAt": "2026-01-01T00:00:00Z",
  "lastPushAt": "2026-01-01T00:10:00Z",
  "lastBackup": "2026-01-01T00-00-00Z",
  "managedSettings": [
    "theme",
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "enabledModels",
    "compaction"
  ]
}
```

该文件属于本机状态，不提交到配置仓库。

## 15. 实施阶段

### Phase 1：MVP

- 标准 Pi Package。
- `/pisync status|diff|pull|push|apply|capture`。
- Settings managed-key 合并。
- 敏感文件 denylist。
- 原子写入和备份。
- Git fast-forward 和 divergence 检查。
- 同步后调用 `ctx.reload()`。
- Bootstrap 脚本。
- 核心逻辑单元测试。

### Phase 2：安全与体验

- macOS、Linux 和 Host 配置覆盖。
- `/pisync doctor`。
- `/pisync rollback`。
- TUI 操作菜单和结构化 diff。
- Secret scanner。
- 第三方 Package reconciliation。
- 状态栏远端更新提示。

### Phase 3：高级能力

- 使用 `age` 或 `sops` 加密秘密同步。
- 多 Profile，例如 `work`、`personal`。
- 独立 `pisync` CLI。
- CI 配置验证。
- Git commit 签名和远端安全检查。

## 16. 测试策略

至少覆盖以下场景：

- 全新机器首次安装。
- 无变化时重复 apply。
- Settings 嵌套对象合并。
- 本机保留字段不被覆盖。
- 远端 fast-forward 更新。
- 本地存在未提交修改。
- 本地与远端分叉。
- JSON 或 Skill 配置损坏。
- 敏感文件被误加入仓库。
- 应用过程中异常退出。
- 两个 Pi 实例同时同步。
- Pull 更新插件自身后执行 Reload。
- Rollback 恢复上一个可用状态。
- `PI_CODING_AGENT_DIR` 指向自定义目录。
- TUI、RPC、JSON 和 Print 模式下的行为差异。

## 17. 核心原则

1. 私人仓库本身作为 Pi Package。
2. Pi 资源直接从仓库加载，不做无必要的双向复制。
3. 只对 Settings 和全局文件做受控 materialize。
4. 认证、会话、缓存和安装产物永不默认同步。
5. 手动同步、先展示 diff、原子应用、随时可回滚。
6. Git 分叉和冲突必须显式处理，不能静默覆盖。
7. Push 等远端副作用必须由用户明确发起。
8. 所有路径都尊重 `PI_CODING_AGENT_DIR`，避免硬编码。

## 18. 结论

该方案充分复用 Pi 原生 Package、资源发现和 `ctx.reload()` 能力，同时通过受控的 Settings 合并、文件 materialize、敏感信息隔离及 Git 冲突保护，避免直接 Git 化整个 `~/.pi/agent` 所带来的凭据泄露、安装目录冲突和配置损坏风险。
