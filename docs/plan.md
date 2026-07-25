# pi-git-sync 简化设计与实现方案

本文描述 pi-git-sync 的目标简化方案。核心假设是：

> 所有目标设备使用同一套 Pi 配置，不提供平台配置、设备配置或机器级覆盖。

本文是目标设计，不代表当前版本的所有行为均已实现。

## 1. 目标

- 使用一个 Git 私有仓库作为共享配置的唯一数据源。
- 通过 Glob 白名单声明需要同步的文件和目录。
- 仓库中的同步目录与 `PI_CODING_AGENT_DIR` 使用相同的相对路径。
- 白名单内的文件在所有设备之间完整共享，不做设备级字段覆盖。
- 使用 Git 管理版本、提交、远端同步和文本冲突。
- 冲突由用户手动解决，pi-git-sync 不自动选择冲突一方。
- 应用配置前展示差异、校验内容并创建备份。
- 认证、会话、安全状态和安装产物永不进入同步范围。

## 2. 非目标

简化方案不提供：

- macOS、Linux 或 hostname 配置覆盖。
- `shared < platform < machine` 分层合并。
- 同一配置文件中的设备专属字段保留。
- 自动解决 Git 冲突。
- 自动同步认证信息和秘密。
- `npm/`、`git/`、`node_modules/` 等安装目录复制。
- 多个长期设备分支的数据叠加。

如果某个白名单文件在不同设备上必须具有不同内容，该文件不适合本方案；应将它移出白名单，或者未来重新引入显式覆盖机制。

## 3. 核心模型

采用：

> **单一 main 分支 + 文件镜像目录 + Glob 白名单 + 本地同步状态**

配置仓库只保存数据，不需要作为 Pi Package 安装。pi-git-sync Extension 本身通过 npm 安装：

```bash
pi install npm:@jachy/pi-git-sync
```

配置仓库建议克隆到：

```text
~/.pi/config-repo
```

Pi 资源由 pi-git-sync 从仓库镜像到 `PI_CODING_AGENT_DIR` 后，按照 Pi 原生顶层目录规则加载。配置仓库本身不再作为第二份 Pi Package 加载，避免 Extension、Skill、Prompt 或 Theme 被重复发现。

## 4. 仓库结构

```text
pi-config/
├── pi-sync.json
├── .gitignore
└── sync/
    ├── settings.json
    ├── AGENTS.md
    ├── SYSTEM.md
    ├── APPEND_SYSTEM.md
    ├── keybindings.json
    ├── extensions/
    ├── skills/
    ├── prompts/
    └── themes/
```

`sync/` 下的相对路径直接对应 agent 目录：

```text
<repo>/sync/AGENTS.md
    ↔
$PI_CODING_AGENT_DIR/AGENTS.md

<repo>/sync/extensions/example.ts
    ↔
$PI_CODING_AGENT_DIR/extensions/example.ts
```

MVP 不支持任意 source/target 映射。统一的镜像路径比逐文件 mapping 更容易理解，也能直接使用 Git diff 表达变更。

## 5. Manifest

建议为简化模型启用新的 schema 版本，避免与旧的 managed-key 配置产生歧义：

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

### 5.1 Glob 规则

- 所有 Glob 相对于 `root` 和 `PI_CODING_AGENT_DIR` 计算。
- 路径统一转换为 `/` 分隔的相对路径。
- `include` 决定可进入同步集合的文件。
- `exclude` 从同步集合中排除文件。
- 内置安全 denylist 的优先级最高，用户不能通过 `include` 重新包含。
- 目录规则递归展开为普通文件；Git 不维护空目录。
- 同一文件匹配多个 include 时只处理一次。
- 符号链接默认拒绝，避免链接逃逸仓库或 agent 根目录。
- `..`、绝对路径、NUL 字符和根目录逃逸路径必须拒绝。
- 在大小写不敏感文件系统上发现路径大小写冲突时停止同步。

规则优先级：

```text
内置 hard deny > manifest exclude > manifest include
```

## 6. 永久禁止同步的内容

即使用户在 `include` 中声明，以下路径仍不能同步：

```text
auth.json
sessions/**
trust.json
models-store.json
npm/**
git/**
node_modules/**
.pi-sync/**
**/.env
**/*.pem
**/id_rsa
**/id_ed25519
```

原因：

- `auth.json`、私钥和 `.env` 包含认证信息或秘密。
- `sessions/` 可能包含对话、源码和其他隐私内容。
- `trust.json` 是本机安全决策，不应由另一台设备决定。
- `models-store.json` 属于可刷新的运行数据。
- `npm/`、`git/`、`node_modules/` 是可重建且与平台、Node 版本相关的安装产物。
- `.pi-sync/` 保存本机锁、状态和备份。

GitHub Private Repository 不是秘密加密存储。Secret scanner 只能作为辅助防线，不能代替 hard deny。

## 7. `settings.json`

简化方案将 `settings.json` 作为一个完整共享文件，不再执行 managed-key merge。

这要求所有设备满足：

- 使用兼容的 Pi 配置格式。
- 配置中的 provider、model、theme、tools 等设置在所有设备上都有效。
- 不包含机器相关绝对路径。
- `externalEditor`、`httpProxy`、`npmCommand` 等字段在所有设备上均可使用。
- `packages` 不包含只在某台机器上存在的绝对本地路径。
- `packages` 中包含 pi-git-sync 自身，否则应用配置后下次启动可能无法加载 `/pisync`。

推荐使用可移植的 package 来源：

```json
{
  "packages": [
    "npm:@jachy/pi-git-sync",
    "npm:some-pi-package",
    "git:github.com/user/pi-package@v1"
  ]
}
```

`doctor` 应将以下情况视为错误或高优先级警告：

- `settings.json` 出现绝对本地 package 路径。
- 出现明显的 home 目录或设备专属路径。
- `packages` 未包含 pi-git-sync。
- JSON 格式错误。
- package 来源格式无效。

## 8. 单一分支策略

既然所有配置完全共享，长期设备分支没有必要：

```text
main = 唯一完整配置状态
```

每台设备都从 main 拉取，并最终向 main 推送。临时 feature branch 或 Pull Request 可以用于审核，但分支不表达设备差异。

默认禁止：

```text
git reset --hard
git clean -fd
git push --force
```

允许的自动 Git 行为：

- `fetch origin`
- 无本地提交时的 fast-forward
- push 前对本机配置提交执行 rebase
- 普通 push

发生分叉或冲突时停止，由用户处理。

## 9. 本地状态与三方比较

仅比较 repo 与 agent 当前内容不足以判断删除和双边修改，因此需要维护同步基线。

状态保存在：

```text
$PI_CODING_AGENT_DIR/.pi-sync/state.json
```

建议格式：

```json
{
  "schemaVersion": 2,
  "repoPath": "/Users/example/.pi/config-repo",
  "branch": "main",
  "lastSyncedCommit": "abc123",
  "lastSyncedAt": "2026-01-01T00:00:00Z",
  "files": {
    "settings.json": {
      "sha256": "...",
      "mode": 420
    },
    "AGENTS.md": {
      "sha256": "...",
      "mode": 420
    }
  },
  "pendingOperation": null,
  "lastBackup": "2026-01-01T00-00-00Z"
}
```

对每个路径比较三个状态：

```text
B = 上次同步基线
L = 当前 agent 文件
R = 当前 repo 文件
```

包括“不存在”在内，按内容 hash 判断：

| 本地 L | 仓库 R | 结论 |
|---|---|---|
| `L = B` | `R = B` | 无变化 |
| `L ≠ B` | `R = B` | 仅本地变化，可 capture |
| `L = B` | `R ≠ B` | 仅仓库变化，可 apply |
| `L = R` | 两者均不同于 B | 已自然收敛 |
| `L ≠ B` | `R ≠ B` 且 `L ≠ R` | 双边修改，停止 |

文件不存在也作为一种值参与比较，因此可识别创建和删除。

## 10. 删除语义

`delete: "tracked"` 表示：

- repo 中删除一个上次已管理的文件，apply 时删除 agent 对应文件。
- agent 中删除一个上次已管理的文件，capture 时删除 repo 对应文件。
- 从未进入同步基线的 agent 文件不会因为 repo 中不存在而被删除。
- hard deny 文件永远不会被删除或覆盖。

删除前必须进入备份，并在 diff 中明确显示：

```text
[delete] prompts/old-review.md
```

## 11. 命令语义

### 11.1 `/pisync status`

显示：

- repo 路径、branch 和 HEAD。
- 相对 `origin/main` 的 ahead/behind。
- repo 是否 dirty 或处于 merge/rebase 状态。
- agent 相对同步基线的新增、修改和删除。
- repo 相对同步基线的新增、修改和删除。
- 双边冲突候选。
- 上次同步时间和 commit。

### 11.2 `/pisync diff`

显示三类差异：

```text
Agent changes to capture
Repository/remote changes to apply
Git changes and conflicts
```

必须展示真实文件级 diff；二进制文件至少展示 hash 和大小变化。

### 11.3 `/pisync capture`

只执行本地到 repo 工作树的捕获，不访问网络、不 commit、不 push：

1. 获取同步锁。
2. 扫描 agent 和 repo 的白名单文件集合。
3. 根据基线检测双边修改。
4. 双边修改时停止，不覆盖任一方。
5. 把仅本地修改复制到 repo。
6. 把 agent 中对已管理文件的删除反映到 repo。
7. 校验捕获结果并展示 Git diff。

`capture` 适合首次迁移和高级用户检查。日常 `/pisync push` 可以内置 capture。

### 11.4 `/pisync apply`

不访问网络，将 repo 当前已提交版本应用到 agent：

1. 获取同步锁。
2. 要求 repo 不处于 merge/rebase 冲突状态。
3. 默认要求 repo 工作树干净。
4. 解析 manifest，计算白名单文件集合。
5. 执行路径安全检查、JSON 校验和资源校验。
6. 计算创建、更新和删除计划。
7. 展示 diff并请求确认。
8. 创建完整备份。
9. 使用临时文件和 rename 原子替换单个文件。
10. 删除 repo 中已删除且属于同步基线的 agent 文件。
11. 任一步骤失败时尝试从本次备份恢复。
12. reconcile `settings.json` 中声明但本机尚未安装的 packages。
13. 仅在全部成功后更新同步状态。
14. 调用 `ctx.reload()`，并立即结束旧命令实例。

单文件 rename 可以是原子的，但多文件 apply 无法形成真正的文件系统事务。因此实现必须采用：

```text
全部预校验 → 完整备份 → 执行写入 → 失败则回滚 → 最后更新 state
```

### 11.5 `/pisync pull`

远端到本机流程：

1. 获取同步锁。
2. 检查 repo 工作树和 Git 操作状态。
3. 检查 agent 相对基线是否有本地修改。
4. 如果 agent 有未捕获修改，停止并提示先 push、capture 或放弃本地修改。
5. 执行 `git fetch origin`。
6. 检查本地 main 与 `origin/main` 的关系。
7. 仅允许 fast-forward；分叉时停止。
8. 在修改 agent 前展示远端 commit 和文件 diff，并请求确认。
9. fast-forward 本地 repo。
10. 校验 repo。
11. 按 `/pisync apply` 流程备份并应用。
12. 成功后更新基线并 reload。

不能先修改 agent 再询问用户是否确认。

### 11.6 `/pisync push`

本机到远端流程：

1. 获取同步锁。
2. 确认 repo 未处于冲突状态。
3. 按 capture 逻辑把 agent 变化写入 repo 工作树。
4. 校验所有白名单内容。
5. 对待提交文件和完整 staged 内容执行 secret scan。
6. 展示创建、修改、删除和完整 Git diff。
7. 请求用户确认。
8. 创建本地 commit。
9. 执行 `git fetch origin`。
10. 如果远端前进，对本地 commit 执行 `git rebase origin/main`。
11. rebase 冲突时保留 Git 冲突现场，记录 pending operation，并停止。
12. 无冲突时 push main。
13. 将最终 HEAD 再 apply 回 agent，确保 rebase 后的仓库内容与 agent 一致。
14. 更新同步基线并 reload。

Push 前的确认必须发生在 commit 和远端副作用之前。

### 11.7 冲突继续

如果 push/rebase 产生冲突：

1. 不修改 agent 当前配置。
2. 不调用 reload。
3. repo 保留标准 Git 冲突现场。
4. 用户在 repo 中手动解决冲突。
5. 用户执行 `git add` 和 `git rebase --continue`，直到 Git 操作完成。
6. 通过显式的 `/pisync push --continue` 继续。

`push --continue` 不得重新 capture agent，否则可能覆盖用户刚解决的 repo 内容。它只执行：

```text
确认无 unmerged path
→ 确认工作树干净
→ 校验最终提交
→ secret scan
→ push
→ apply 最终 HEAD
→ 更新 state
→ reload
```

如果用户执行 `git rebase --abort`，下次 status/doctor 应识别并清理已失效的 pending 状态。

### 11.8 `/pisync rollback`

Rollback 只恢复 agent 配置，不重写 Git 历史：

1. 显示目标备份。
2. 请求确认。
3. 先备份当前 agent 状态。
4. 恢复所选备份。
5. 校验恢复后的配置。
6. reload。

如需回退共享配置版本，应使用 Git revert 或 checkout 后再 apply。

## 12. 冲突原则

Git 冲突由用户手动处理，但实现必须保证：

- 冲突只保留在配置 repo 中。
- 含 `<<<<<<<`、`=======`、`>>>>>>>` 的文件不能 apply。
- JSON、Theme、Extension、Skill 等未通过校验时不能 apply。
- agent 继续保留上一个成功版本。
- 冲突解决并提交前不能 push 或 reload。
- 工具不调用 LLM 自动修改冲突文件。

Git 只能检测已进入 repo 的变化。agent 中尚未 capture 的修改由同步基线和内容 hash 检测，不能假设 Git 会自动发现。

## 13. 文件应用和安全

### 13.1 原子写入

每个文件采用：

```text
写入目标目录中的唯一临时文件
→ 设置 mode
→ fsync 文件
→ rename 到目标路径
→ 必要时 fsync 父目录
```

临时文件必须在目标文件同一文件系统和目录中，确保 rename 的原子性。

### 13.2 备份

备份目录：

```text
$PI_CODING_AGENT_DIR/.pi-sync/backups/<timestamp>/
```

备份需要记录：

- apply 前存在的文件内容和 mode。
- apply 前不存在、但本次将创建的路径。
- 本次计划删除的文件。
- repo commit。
- 操作类型。

这样 rollback 才能同时恢复覆盖、删除本次新建文件和重新创建本次删除文件。

### 13.3 并发锁

锁文件：

```text
$PI_CODING_AGENT_DIR/.pi-sync/sync.lock
```

锁至少记录：

```json
{
  "pid": 12345,
  "hostname": "host",
  "startedAt": "2026-01-01T00:00:00Z",
  "operation": "push"
}
```

删除失效锁前必须检查 PID、hostname 和锁年龄。

### 13.4 Secret scan

Push 前至少扫描：

- 新增和修改的完整文件内容，而不只扫描 diff 上下文。
- staged diff。
- 私钥头、常见 API key、Token、JWT 和高置信度通用 secret。

发现疑似 secret 时默认阻止 push，由用户移除内容。Private Repo 不改变默认阻止策略。

## 14. Package 处理

不复制：

```text
npm/
git/
node_modules/
```

只共享 `settings.json` 中的 package 来源声明。apply 后：

1. 读取共享 `settings.json` 的 `packages`。
2. 检查本机对应 package 是否已安装。
3. 对缺失 package 调用参数数组形式的 `pi install <source>`。
4. 不通过 shell 拼接 package source。
5. 安装失败时报告错误，不把部分成功标记为完整同步成功。

不要求各设备的安装产物二进制一致，只要求它们由相同声明重建。

## 15. 初始化流程

新机器：

```bash
pi install npm:@jachy/pi-git-sync
```

然后：

```text
/pisync init git@github.com:<user>/pi-config.git
```

初始化逻辑：

1. 检查 Git、Pi CLI 和仓库访问权限。
2. Clone 到 `~/.pi/config-repo`。
3. 空仓库时创建 schema v2 manifest 和 `sync/` 目录。
4. 不执行 `pi install ~/.pi/config-repo`。
5. 已有配置时校验后 apply。
6. 空配置时提示执行 capture，将当前白名单配置导入仓库。
7. 首次 push 成功后建立同步基线。

Bootstrap 仍然需要先安装 pi-git-sync，因为配置同步功能不能依赖尚未被同步的 Extension 自举。

## 16. 内部实现划分

建议目标模块：

```text
src/
├── config.ts          # schema v2 manifest 解析和校验
├── glob.ts            # include/exclude 和路径规范化
├── inventory.ts       # repo/agent 文件枚举、hash 和三方比较
├── capture.ts         # agent → repo
├── materialize.ts     # repo → agent、删除计划和原子写入
├── validate.ts        # JSON、Skill、Theme、冲突标记校验
├── git.ts             # fetch、ff、commit、rebase、push 和冲突状态
├── backup.ts          # 完整备份和恢复
├── lock.ts            # 同步锁
├── security.ts        # hard deny 和 secret scan
├── packages.ts        # package 声明 reconcile
├── state.ts           # 基线、hash 和 pending operation
├── doctor.ts          # 环境、路径和可移植性检查
├── commands.ts        # 命令编排，不包含底层文件逻辑
└── ui.ts              # diff、确认和结果展示
```

核心文件同步和 Git 流程应独立于 Pi TUI，以便进行单元测试并在未来复用为 CLI。

## 17. 实现顺序

### Phase 1：文件模型

- schema v2 manifest。
- Glob include/exclude。
- hard deny。
- agent/repo 镜像路径。
- 文件 inventory 和 SHA-256。
- 同步基线和三方比较。
- 创建、更新和 tracked deletion。

### Phase 2：安全应用

- 全部预校验。
- 原子单文件写入。
- 完整备份和失败回滚。
- settings 整文件同步。
- package reconciliation。
- apply 后 reload。

### Phase 3：Git 工作流

- status/diff/capture。
- fast-forward pull。
- capture、commit、rebase、push。
- 冲突停止和 `push --continue`。
- Secret scan。
- TUI diff 和副作用确认。

### Phase 4：迁移和体验

- 从旧 schema 生成新 `sync/` 镜像。
- 检测并移除配置 repo 的重复本地 Package 加载声明。
- doctor 可移植性检查。
- 备份列表和 rollback UI。

## 18. 测试要求

至少覆盖：

- 空仓库首次初始化。
- 首次 capture 和 push。
- 无变化时重复 pull/apply/push。
- Glob include、exclude 和 hard deny 优先级。
- Windows 路径分隔符规范化。
- `..`、绝对路径和符号链接逃逸。
- 大小写路径冲突。
- 本地新增、修改、删除。
- repo 新增、修改、删除。
- 两边修改相同文件且内容不同。
- 两边修改后内容相同。
- 本地删除与远端修改冲突。
- 远端删除与本地修改冲突。
- agent 有未 capture 修改时拒绝 pull。
- repo dirty 时拒绝 apply。
- fast-forward pull。
- branch divergence。
- rebase 冲突和 `push --continue`。
- 冲突文件永不 materialize。
- settings JSON 损坏。
- settings 中存在绝对 package 路径。
- Secret 和 hard-denied 文件阻止 push。
- apply 中途失败后回滚。
- 两个 Pi 实例并发同步。
- package 安装失败不标记完整成功。
- reload 后不继续使用旧 Extension Context。
- 自定义 `PI_CODING_AGENT_DIR`。

## 19. 关键取舍

### 优点

- 心智模型简单：白名单内的文件就是共享配置。
- repo 与 agent 同构，Git diff 直观。
- 不需要 platform/machine overlay。
- `settings.json` 不需要字段级 merge。
- Git 负责版本历史和已提交内容冲突。
- 新文件类型通常只需增加 Glob，不需开发新同步模块。

### 代价

- 所有设备必须接受完全一致的白名单配置。
- `settings.json` 必须保持可移植。
- repo 与 agent 存在两份文件，需要明确 capture/apply 方向。
- 未 capture 的 agent 变化仍需本地基线检测，不能只依赖 Git。
- 多文件 apply 不能成为真正的文件系统事务，只能通过预校验、备份和回滚保证安全。
- 发生 Git 冲突时需要用户理解并操作 Git。

## 20. 核心原则

1. `main` 是共享配置的唯一事实来源。
2. 所有设备使用同一份白名单配置。
3. repo `sync/` 与 agent 目录采用相同相对路径。
4. 白名单控制功能范围，hard deny 控制安全边界。
5. `settings.json` 整体共享，但必须可移植且不包含秘密。
6. 安装产物不复制，只同步 package 来源声明。
7. 使用同步基线进行三方比较，正确识别双边修改和删除。
8. Pull 只允许 fast-forward；Push 冲突由用户手动解决。
9. 冲突期间不 apply、不 reload、不破坏当前可用配置。
10. 先展示 diff、再确认、再执行 commit/push/apply 等副作用。
11. apply 先校验、再备份、失败回滚、最后更新状态。
12. 所有路径尊重 `PI_CODING_AGENT_DIR`，不硬编码 agent 目录。
