# pi-git-sync 完整测试方案

> 状态：拟实施  
> 最后更新：2026-07-26  
> 适用版本：`@jachy/pi-git-sync` 0.1.x（当前基线 0.1.16）

## 1. 目的

本方案用于为 pi-git-sync 建立一套可重复、可隔离、可在 CI 中执行的完整测试体系，重点验证以下承诺：

1. 基于同步基线的三方比较能够正确识别新增、修改、删除、收敛和冲突。
2. `capture → commit → fetch → rebase → push → apply` 全链路不会丢失或错误覆盖用户配置。
3. apply 遵循“全部预校验 → 完整备份 → 执行写入 → 失败回滚 → 最后更新 state”的顺序。
4. hard deny、路径校验和 secret scan 不可被用户配置、路径写法或符号链接绕过。
5. Git 分叉、rebase 冲突、并发执行、进程中断和外部命令失败时能够安全停止并给出可恢复状态。
6. Extension 注册、命令解析、确认交互、通知和 `ctx.reload()` 生命周期符合 Pi Extension 契约。
7. Node.js 18+、主要操作系统及自定义 `PI_CODING_AGENT_DIR` 下行为一致。

本方案既覆盖当前实现，也作为后续功能修改的回归测试基线。

## 2. 当前测试基线

截至本文编写时，已执行：

```text
npm run typecheck                         通过
npm test -- --reporter=verbose           通过
Test Files                               9 passed
Tests                                    76 passed
```

现有测试文件：

| 测试文件 | 已覆盖内容 | 主要缺口 |
| --- | --- | --- |
| `test/config.test.ts` | schema v2 的部分合法/非法配置及默认值 | 字段类型全集、空值、非法 branch/root、配置文件 I/O 错误 |
| `test/git.test.ts` | status、commit、HEAD、dirty、ancestor、基础 diff | fetch/pull/push/rebase、分叉、冲突、Git operation state、超时和错误输出 |
| `test/init.test.ts` | 空 bare remote 的首次初始化与推送 | 已有仓库、幂等、`--force`、URL 不匹配、clone/fetch 失败 |
| `test/lock.test.ts` | 获取、释放、并发拒绝、stale lock、读取信息 | 等待超时、损坏锁、非 owner 释放、跨进程竞争、异常退出 |
| `test/materialize.test.ts` | atomic write、基础 apply、tracked deletion、read/hash | 校验失败、权限/mode、失败回滚、symlink/path escape、多文件部分失败 |
| `test/minimatch.test.ts` | `*`、`**`、`?` 和部分边界 | 生产路径实际使用的 `src/glob.ts` 内部 matcher 未被直接覆盖 |
| `test/packages.test.ts` | package diff | 安装/更新/删除命令、参数注入、CLI 缺失、超时和部分失败 |
| `test/security.test.ts` | hard deny 和常见 secret | 大小写/分隔符绕过、完整文件扫描、误报边界、行号和批量结果 |
| `test/settings.test.ts` | v1 遗留 deep merge/equal | `mergeSettings` I/O；该模块不是 v2 核心路径 |

当前测试尚未直接覆盖或覆盖很少的核心模块包括：

- `index.ts`
- `src/backup.ts`
- `src/capture.ts`
- `src/commands.ts`（除 init 的一个 E2E 场景外）
- `src/glob.ts`
- `src/inventory.ts`
- `src/state.ts`
- `src/ui.ts`
- `src/validate.ts`

当前没有覆盖率 provider、覆盖率阈值和仓库内 CI workflow。`src/minimatch.ts` 目前没有生产调用方，而生产同步路径使用 `src/glob.ts` 中的 matcher；不能用前者的测试覆盖率代替后者。

## 3. 范围与优先级

### 3.1 测试范围

测试范围包含：

- Extension 入口、事件与命令注册：`index.ts`
- 配置、glob、路径和安全规则
- 文件枚举、hash、同步基线和三方比较
- capture、materialize、备份、回滚和状态持久化
- Git 本地操作、bare remote、fast-forward、rebase 和冲突继续
- package reconciliation 与外部 `pi` 命令
- 所有用户可见格式化输出
- `scripts/bootstrap.sh`
- npm 打包内容和 Node.js 版本兼容性

默认 CI 测试不得读写真实的 `~/.pi`，不得访问真实 GitHub 仓库，也不得依赖开发者机器的全局 Git 配置。

### 3.2 优先级定义

| 优先级 | 含义 | 失败处理 |
| --- | --- | --- |
| P0 | 可能泄漏秘密、覆盖/删除配置、产生错误同步基线、破坏 Git 冲突现场 | 阻止合并和发布 |
| P1 | 核心命令错误、跨平台失败、诊断和恢复能力失效 | 阻止合并；修复后发布 |
| P2 | 文案、格式、低风险兼容或性能退化 | 可按发布策略评估，但必须记录 |

### 3.3 不在自动化测试中的内容

- 不在普通 CI 中使用个人 GitHub 凭证或真实私有仓库。
- 不验证 GitHub 服务本身的可用性。
- 不复制或断言 `npm/`、`git/`、`node_modules/` 中的平台安装产物一致。
- 不以精确耗时作为功能断言；性能测试使用宽松预算和趋势监控。

## 4. 测试分层

| 层级 | 目标 | 依赖策略 | 建议比例 |
| --- | --- | --- | --- |
| 静态检查 | 类型、脚本语法、包内容 | `tsc`、`bash -n`、`npm pack --dry-run` | 每次 PR |
| 单元测试 | 纯函数、分类矩阵、格式化、校验规则 | 无磁盘或仅内存数据 | 约 45% |
| 文件系统组件测试 | state、capture、materialize、backup、lock | 临时目录和真实文件系统 | 约 25% |
| Git 集成测试 | 本地仓库、bare remote、分叉/rebase/冲突 | 真实 `git`，无公网 | 约 20% |
| Extension 契约测试 | 注册、参数路由、确认、notify、reload | fake Pi API + mock UI | 约 7% |
| 端到端测试 | 两台“设备”的完整同步与恢复 | 两个 agent dir + 两个 clone + bare remote | 约 3% |

原则：纯业务规则优先做表驱动单元测试；Git 行为使用真实 Git 仓库而不是模拟 Git 输出；只在 Pi API/UI 边界和不可控外部进程边界使用 mock。

## 5. 测试基础设施

### 5.1 推荐目录

```text
test/
├── unit/
│   ├── config.test.ts
│   ├── glob.test.ts
│   ├── inventory.test.ts
│   ├── security.test.ts
│   ├── validate.test.ts
│   └── ui.test.ts
├── integration/
│   ├── state.test.ts
│   ├── capture.test.ts
│   ├── materialize.test.ts
│   ├── backup.test.ts
│   ├── lock.test.ts
│   ├── git.test.ts
│   ├── packages.test.ts
│   └── commands.test.ts
├── contract/
│   └── extension.test.ts
├── e2e/
│   ├── init.test.ts
│   └── two-device-sync.test.ts
├── fixtures/
│   ├── configs/
│   ├── settings/
│   ├── secrets/
│   └── file-trees/
└── helpers/
    ├── temp-env.ts
    ├── config-factory.ts
    ├── state-factory.ts
    ├── git-fixture.ts
    ├── agent-fixture.ts
    ├── fake-pi.ts
    └── failure-injection.ts
```

可分阶段迁移现有测试；迁移期间不得仅为调整目录而改变断言语义。

### 5.2 隔离规则

每个测试必须：

1. 使用 `fs.mkdtemp()` 创建独立根目录，并在 `afterEach`/`afterAll` 清理。
2. 将 `HOME`、`USERPROFILE`、`PI_CODING_AGENT_DIR`、Git 配置和 fake `PATH` 指向临时目录。
3. 保存并恢复被修改的 `process.env`、fake timer、spy 和 mock。
4. 不读取真实 SSH agent、用户级 `.gitconfig`、credential helper 或真实 `~/.pi`。
5. 对修改全局环境变量的 suite 串行执行，或放入独立 worker/fork。
6. Git commit 使用测试内显式的 `user.name`、`user.email` 和固定时间，保证结果可复现。
7. 设置 `GIT_TERMINAL_PROMPT=0`、非交互 editor，并为子进程设置超时。

建议提供统一的 `createTestEnvironment()`，返回：

```ts
{
  rootDir,
  agentDir,
  repoDir,
  remoteDir,
  cleanup,
  writeAgentFile,
  writeRepoFile,
  readState,
  git,
}
```

### 5.3 Git fixture

Git 集成测试使用本地 bare remote 构造拓扑：

```text
remote.git (bare)
├── device-a clone
└── device-b clone
```

helper 应支持：

- 初始化空远端和带已有提交的远端；
- 创建 branch、commit、tag；
- 构造 ahead、behind、diverged；
- 构造可自动 rebase 和必然冲突的提交；
- 读取 HEAD、工作树状态、unmerged paths 和远端 ref；
- 保持提交 SHA、作者和时间可预测。

### 5.4 失败注入

P0 恢复路径不能只依靠修改文件权限触发，因为 root、Windows 和不同文件系统下结果不稳定。建议为文件写入、rename、unlink、package exec 和 reload 提供最小可替换边界，测试时可在第 N 次操作抛错。若暂不重构，则至少使用稳定的 spy/mock，并补一条真实权限错误平台测试。

必须能够注入：

- 校验失败；
- 第 N 个文件 write/rename/unlink 失败；
- 备份创建失败、备份恢复失败；
- `git fetch/rebase/push` 非零退出或超时；
- `pi install/remove` 非零退出或超时；
- state 保存失败；
- `ctx.reload()` reject。

## 6. 单元与组件测试矩阵

### 6.1 配置：`src/config.ts`

| ID | 场景 | 期望 | 优先级 |
| --- | --- | --- | --- |
| CFG-01 | 最小合法 schema v2 | 正确补全 branch、root、exclude、delete、security 默认值 | P0 |
| CFG-02 | 完整合法配置和自定义 branch/root | 所有字段保持不变 | P1 |
| CFG-03 | 缺失/错误 `schemaVersion` | 明确拒绝且错误可定位 | P0 |
| CFG-04 | include/exclude 不是数组，或元素不是字符串 | 拒绝 | P0 |
| CFG-05 | root/include/exclude 含 `..`、NUL、绝对路径 | 拒绝 | P0 |
| CFG-06 | branch/root 为空、类型错误或危险值 | 拒绝 | P0 |
| CFG-07 | delete 不是 `tracked`/`none` | 拒绝 | P0 |
| CFG-08 | security 字段缺失、类型错误、带未知值 | 默认或按 schema 明确拒绝 | P1 |
| CFG-09 | `pi-sync.json` 不存在、无权限、JSON 损坏 | `loadPiSyncConfig` 返回可理解错误，不吞掉原始原因 | P0 |
| CFG-10 | 调用方修改返回对象 | 不污染 `DEFAULT_CONFIG` | P1 |

### 6.2 Glob 与路径安全：`src/glob.ts`、`src/minimatch.ts`

覆盖 `*`、`**`、`?`、空字符串、末尾 `/`、连续 `/`、`.`、Unicode、空格、特殊正则字符、隐藏文件和超长路径。核心断言：

- Windows `\` 统一为 `/`；`./a` 规范化为 `a`。
- NUL、`..`、绝对 POSIX 路径、盘符路径和 UNC 路径不能逃出 agent/repo root。
- include 命中但 hard deny 命中时仍拒绝。
- include 和 exclude 同时命中时 exclude 生效。
- 未命中 include 时拒绝但不误报为 hard deny。
- `filterAllowedFiles` 保持确定性，不重复、不遗漏输入路径。
- hidden files（允许的 `.gitignore` 例外）和 symlink 规则与 README 一致。
- 大小写冲突（如 `Themes/A.json` 与 `themes/a.json`）在大小写不敏感平台上被检测并阻止。

应直接测试 `src/glob.ts` 的生产实现。后续应合并重复 matcher，或增加一致性契约测试，确保 `src/minimatch.ts` 与 `src/glob.ts` 不会静默漂移。

### 6.3 三方比较：`src/inventory.ts`

使用表驱动测试覆盖完整状态空间：

| B（基线） | L（agent） | R（repo） | 期望分类 |
| --- | --- | --- | --- |
| A | A | A | `no_change` |
| A | B | A | `local_only` |
| A | A | B | `remote_only` |
| A | B | B | `converged` |
| A | B | C | `both_modified` |
| 不存在 | A | 不存在 | `local_created` 或规则要求的 `untracked_local` |
| 不存在 | 不存在 | A | `remote_created` |
| 不存在 | A | A | `converged` |
| A | 不存在 | A | `local_deleted` |
| A | A | 不存在 | `remote_deleted` |
| A | 不存在 | 不存在 | `both_deleted` |
| A | B | 不存在 | `local_modified_remote_deleted` |
| A | 不存在 | B | `local_deleted_remote_modified` |

额外覆盖：

- 内容相同但 mode 不同、空文件、二进制、Unicode 文件名；
- include/exclude/hard deny 后的枚举集合；
- symlink、目录 symlink、循环 symlink；
- baseline 缺失、部分损坏和旧版本迁移后的比较；
- `hasBilateralConflicts`、`hasLocalChanges`、`getCapturableFiles`、`getApplicableFiles` 的每种分类；
- 目录中 10,000 个文件时结果稳定且排序确定。

### 6.4 State：`src/state.ts`

验证：

- state 不存在时返回安全的空状态；
- save/load round-trip 保留 repoPath、commit、时间、文件 hash 和 mode；
- `updateState` 合并字段但不丢 baseline；
- v1 → v2 migration 的合法、缺字段和未知字段输入；
- JSON 截断、非法 JSON、错误类型、无读写权限；
- state 写入使用临时文件/rename 时不留下半文件；
- 并发保存不会产生可解析但内容混合的状态；
- `computeBaselineEntry` 和 `getBaselineFile` 的存在/不存在分支。

任何 capture/apply/pull/push 的失败路径都必须断言 state 没有被提前更新。

### 6.5 Capture：`src/capture.ts`

验证：

- 本地新增、修改、删除被正确复制/删除到 repo；
- `delete: "none"` 不删除 repo 文件；
- 未进入 baseline 的本地文件不触发错误删除；
- 无变化时幂等，结果计数和输出为空变化；
- 双边冲突、hard deny、symlink、路径逃逸会在写 repo 前失败；
- 二进制内容、mode、嵌套目录、Unicode 路径正确保留；
- `verifyCapture` 检出内容/hash 不一致和捕获后文件消失；
- 第 N 个文件写入失败时明确报告部分结果，命令层不得 commit/push 或更新 state；
- capture 不访问网络、不 commit、不 push。

### 6.6 Materialize：`src/materialize.ts`

验证：

- create/update/delete/no-op 计划正确，结果排序稳定；
- 仅删除 baseline 中已跟踪且 `delete: "tracked"` 的文件；
- hard deny 文件永不覆盖或删除；
- repo dirty、冲突 marker、非法 JSON、不可移植 settings 在写入前被拒绝；
- target 是 symlink、父目录是 symlink、目标路径穿越时拒绝；
- `atomicWrite` 的临时文件与目标同目录，rename 后无残留临时文件；
- 覆盖时保留预期 mode，新建目录权限合理；
- 空文件、大文件、二进制和 Unicode 内容不损坏；
- 多文件第 N 步失败时由命令层使用本次备份恢复所有已变更文件；
- `executeMaterialize` 失败时不报告完整成功，state 不更新。

### 6.7 Backup 与 rollback：`src/backup.ts`

验证：

- 备份清单记录 commit、reason、timestamp、内容、mode、原先不存在的路径和计划删除路径；
- restore 同时做到：恢复被覆盖文件、重新创建被删除文件、删除 apply 新建文件；
- 备份清单损坏、data 文件缺失、hash 不匹配时拒绝恢复；
- list 按时间稳定排序，latest 正确；
- cleanup 只删除超出保留数的旧备份，不删除进行中的备份；
- restore 中途失败时返回清楚的恢复状态，不静默标记成功；
- 失败恢复不修改 Git 历史、branch 或远端，且可重复执行。

### 6.8 校验：`src/validate.ts`

验证：

- conflict marker 的完整形式、缺失一段、正常 `<<<` 文本和不同行尾；
- 所有 `.json` 合法/非法、空文件、BOM、错误位置；
- `settings.json` 的绝对 package 路径、home 路径、设备专属路径；
- package source 格式、缺少 pi-git-sync、自身多种合法 npm 表示；
- `externalEditor`、`httpProxy`、`npmCommand` 等不可移植值；
- 多文件校验聚合全部错误，而不是仅返回第一个；
- 不在配置 root 下的文件不能被读取；
- 校验只读，不改变文件和 state。

### 6.9 安全：`src/security.ts`

必须为每个 hard deny 规则准备正例、相似但合法的反例和路径变体：

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

Secret scan 覆盖 GitHub/OpenAI token、JWT、Bearer token、私钥头、高置信度通用 secret、跨行内容、文件首尾、CRLF 和批量文件。还应验证：

- 扫描完整新增/修改文件，不只扫描 diff 上下文；
- finding 带正确 file/type/line；
- 明显占位符和文档示例的误报策略有固定测试；
- secret 位于 binary、超大文件或无末尾换行时行为明确；
- `scanSecretsBeforePush: false` 只关闭 scanner，不关闭 hard deny；
- private remote 不降低默认拦截级别。

### 6.10 Lock：`src/lock.ts`

除现有用例外增加：

- 两个独立 Node 进程同时竞争，仅一个成功；
- `timeoutMs` 为 0、有限值和到期边界；
- owner 正常释放，非 owner/旧实例不能删除新 owner 的锁；
- 持锁进程崩溃后 stale lock 可恢复；
- 活跃 PID 不被误判 stale；
- 损坏 JSON、缺 pid、pid 复用风险和未来时间戳；
- acquire 异常后不遗留锁；release 幂等；
- 不同 syncDir 的锁互不影响。

### 6.11 Git：`src/git.ts`

使用真实 Git 覆盖：

- 非 Git 目录、无 commit、无 origin、远端不可达、远端 branch 不存在；
- clean/dirty/staged/untracked/unmerged，ahead/behind/diverged；
- diff、staged diff、range diff、name-only、binary diff；
- fetch、fast-forward pull、push、branch rename；
- clean rebase、内容冲突、`rebase --continue`、abort；
- merge/rebase operation state 和 unmerged paths；
- commit message 包含空格、引号、Unicode、以 `-` 开头和 shell 元字符；
- 所有参数以数组传递，不经 shell 拼接；
- timeout、spawn 失败和不同 Git 错误输出均返回非成功；
- `buildGitEnv` 禁止交互，同时不丢必要环境变量；
- commit 失败不能被“HEAD 未变化”等情况误判成功。

### 6.12 Packages：`src/packages.ts`

验证：

- settings 缺失/损坏/无 packages、字符串和 `{ source }` 两种声明；
- npm、git、带版本来源的规范化和同名不同来源；
- 缺失 package 安装、来源变化更新、本机额外 package 不被无意卸载；
- `pi` 不存在、install/remove 失败、超时、部分成功；
- package source 含空格、`;`、`$()`、引号和换行时仍作为单一 argv，不能注入命令；
- 子进程收到正确 `PI_CODING_AGENT_DIR`；
- 任一 reconcile 失败时 apply/pull/push 不更新完整成功状态；
- 重试后只处理仍缺失的 package，保证幂等。

### 6.14 UI：`src/ui.ts`

为所有 formatter 建立稳定的 inline snapshot 或结构化断言：

- clean、ahead/behind、dirty、rebase/merge；
- 13 种三方比较分类；
- 空结果、单文件、多文件、长路径、Unicode；
- binary diff 使用 hash/size 而不是乱码；
- validation、secret、backup、package 和 capture 结果；
- 时间使用固定时区/固定输入，测试不依赖运行机器 locale；
- 输出排序稳定，危险操作和冲突有明确标识。

避免只做整段大 snapshot；关键状态、路径和计数应有独立断言。

### 6.15 `src/settings.ts`

该模块标注为 v1 遗留。先增加 `mergeSettings` 的 I/O、preserve、hostname 和错误场景测试，再决定：

- 若仍属于兼容 API，保留测试并明确兼容期；
- 若无生产调用方，建立删除计划，避免长期维护无效覆盖率。

## 7. 命令工作流测试：`src/commands.ts`

### 7.1 通用前置条件

每个有副作用的命令都应验证：

- repo 路径解析尊重参数、配置覆盖和 `PI_CODING_AGENT_DIR`；
- lock 获取发生在写文件/Git 副作用之前，并在成功或失败后释放；
- 前置检查失败时不执行后续步骤；
- 结果中的 `ok/message/reload` 与真实状态一致；
- 只有完整成功后保存 state；
- secret、路径和校验错误不会被转成普通 warning 后继续执行。

### 7.2 命令场景

| 命令 | 必测场景 | 关键断言 | 优先级 |
| --- | --- | --- | --- |
| status | 未初始化、clean、dirty、ahead/behind、rebase/merge、所有 inventory 分类 | 只读；展示 repo/branch/HEAD、基线、冲突和上次同步 | P1 |
| diff | agent、repo、Git 三类差异；text/binary/no-op | 文件级结果完整；binary 至少显示 hash/size | P1 |
| push 的捕获阶段 | create/update/delete/no-op/conflict/denied | 提交前正确暂存本地变更；由 push 统一验证、确认和推送 | P0 |
| apply | dirty repo、冲突、验证失败、成功、多文件中途失败 | 先验证和备份；失败回滚；成功后 state/reconcile | P0 |
| pull | 本地未 capture、up-to-date、fast-forward、diverged、fetch 失败 | 本地修改时拒绝；只允许 FF；确认前不修改 agent | P0 |
| push | 首推、no-op、clean rebase、远端不存在、secret、push 失败 | 顺序严格；失败不 apply、不更新 state | P0 |
| push --continue | 无 pending、有 unmerged、worktree dirty、解决完成、已 abort | 绝不重新 capture；最终 scan/push/apply；冲突时不 reload | P0 |
| init | 空 remote、已有合法 repo、重复 init、URL 不匹配、`--force`、clone 失败 | 幂等；保留/重建规则正确；不会把配置仓库装成 Pi Package | P0 |
| clearRepo | 取消、成功、local/remote 失败 | 只在显式确认后执行；保留 `.git`；错误不伪装成功 | P1 |

### 7.3 Push 顺序断言

至少有一组测试使用调用记录明确断言：

```text
lock
→ load/validate config
→ inventory
→ capture
→ commit
→ fetch
→ rebase
→ validate
→ secret scan
→ push
→ backup/apply
→ reconcile packages
→ save state
→ reload request
→ release lock
```

不同分支可跳过不需要的步骤，但不能打乱安全顺序。例如 secret scan 必须早于 push，state 必须晚于所有文件和 package 操作成功。

### 7.4 Pull/apply 失败恢复断言

构造 agent 中至少三个文件：一个待覆盖、一个待删除、一个 repo 新建。让第二个写操作失败，最终必须满足：

- 三个 agent 路径均恢复到操作前状态；
- mode 恢复；
- state commit/baseline 未变化；
- 本次备份仍可用于诊断；
- 不调用 reload；
- 错误同时包含原始失败和回滚结果。

## 8. Extension 契约测试：`index.ts`

构造 fake `ExtensionAPI` 和 fake `ExtensionCommandContext`，验证：

1. 注册 `pisync` 和 `debug:clear-repo`，描述与 handler 存在。
2. 注册 `session_start`/`session_shutdown`，两者清理 `pi-sync` status。
3. 参数路由覆盖：空参数、未知参数、额外空白、`init --force URL`、`push --continue`、多词 commit message。
4. TUI 可用时使用 `SelectList`；RPC/non-interactive 模式使用可用 fallback；取消不执行副作用。
5. 所有危险操作必须先 `confirm`，拒绝确认时不调用命令方法。
6. success/warning/error/detail 分类映射到正确 notify level。
7. `ctx.ui.setStatus` 在成功和异常时都被清理。
8. 仅当结果要求 reload 时调用一次 `ctx.reload()`。
9. reload 后旧 handler 不继续访问旧 Extension Context 或继续执行副作用。
10. command method reject 时给出错误通知，不出现 unhandled rejection。
11. debug clear 命令的取消、失败和成功路径分别测试。

若内部函数不可访问，应通过注册后的 handler 验证外部行为，不为覆盖率直接导出 UI 私有实现。

## 9. 端到端场景

### E2E-01：空仓库首次初始化

```text
创建 bare remote
→ device A init
→ 验证 pi-sync.json 和 sync/ 脚手架
→ 验证 main 已推送
→ 再次 init
→ 验证幂等且无多余 commit
```

### E2E-02：首次 capture 和 push

```text
agent A 写入 settings.json、prompt 和 theme
→ capture
→ push
→ 验证 remote 内容、commit、state baseline
→ hard deny 文件始终未进入 repo
```

### E2E-03：两设备同步

```text
A 首推
→ B init/apply
→ 比较 A/B 白名单内容
→ A 修改并 push
→ B pull
→ 再次比较内容、mode、state commit
→ 重复 pull/apply/push 均为 no-op
```

### E2E-04：双边冲突与继续

```text
A、B 从同一基线修改同一文件为不同内容
→ A push
→ B push 发生 rebase 冲突
→ 验证 B agent 未改变、未 reload、repo 保留冲突现场
→ 手工写入解决内容并 git add/rebase --continue（或按实际工作流）
→ /pisync push --continue
→ 验证没有重新 capture，最终内容被 push/apply，state 收敛
```

### E2E-05：删除与回滚

覆盖 remote delete/local delete、`tracked`/`none`、删除与修改冲突；成功 apply 后 rollback，验证覆盖、删除和新建路径均恢复，Git HEAD 不变。

### E2E-06：故障恢复

分别在 fetch、rebase、push、apply 第 N 个文件、package install、state save 和 reload 注入故障。断言每个失败点的 agent/repo/remote/state 最终状态与设计一致，并且下一次命令可以安全重试。

## 10. 跨平台、兼容性与非功能测试

### 10.1 运行矩阵

| 维度 | PR | main/nightly |
| --- | --- | --- |
| Node.js | 18、20、22 | 18、20、22 |
| Ubuntu | 完整 unit + integration + E2E | 完整套件 |
| macOS | Node 22 平台 smoke | 完整文件/Git/E2E |
| Windows | Node 22 路径/Git smoke | 完整文件/Git/E2E |
| Git | runner 默认稳定版 | 可增加最低支持版与最新版 |

Windows symlink 测试若 runner 无创建权限，应明确 skip 原因；路径规范化和 symlink 拒绝逻辑仍必须通过可控 fixture 测试，不能把整个安全 suite 跳过。

### 10.2 文件系统兼容

覆盖：

- POSIX/Windows 分隔符；
- 大小写敏感和不敏感文件系统；
- CRLF/LF、UTF-8 BOM、Unicode 规范化；
- 文件 mode、只读文件、目录无权限；
- 长路径、深目录、空目录；
- symlink、dangling symlink、目录 symlink；
- 磁盘空间/rename/unlink 失败的注入场景。

### 10.3 性能与资源

建议建立不阻塞普通 PR 的 nightly benchmark：

- 10,000 个小文件的 inventory/status；
- 1,000 个文件的 capture/apply 计划；
- 100 MB 单文件的 hash、secret scan 和 binary diff；
- 100 次 no-op status/pull 的进程、文件描述符和临时文件泄漏检查。

初始预算以 CI 基线的 p95 × 2 设门槛，连续多次退化再阻断，避免偶发 runner 抖动。功能测试仍需断言操作在配置的子进程 timeout 内结束。

### 10.4 安全专项

- 对 path、glob 和 package source 增加表驱动攻击样本；条件允许时引入 property-based/fuzz 测试。
- 仓库内运行 secret scanner，确保测试 fixture 使用明确的假 token，不提交真实凭证。
- 日志和错误信息执行脱敏断言。
- `npm pack` 检查不包含 test 临时目录、`.pi-sync`、fixture secret 或本机路径。

## 11. Bootstrap 与发布测试

`scripts/bootstrap.sh` 至少执行：

- `bash -n scripts/bootstrap.sh`；
- 使用临时 HOME 和 fake `pi`/`git`/package manager 的成功路径；
- 缺少依赖、安装失败、重复执行、带空格路径；
- 不写真实 HOME，不泄漏命令行凭证；
- 所有变量正确引用，外部输入不进入 `eval`。

发布前执行：

```text
npm run typecheck
npm run test:coverage
npm run test:e2e
npm pack --dry-run
```

检查 tarball 至少包含 `index.ts`、`src/`、`scripts/`、README 和 LICENSE，不包含测试临时文件和本机状态。

## 12. 覆盖率与质量门禁

建议安装 `@vitest/coverage-v8` 并新增 `test:coverage`。初始门槛：

| 范围 | Lines | Statements | Functions | Branches |
| --- | ---: | ---: | ---: | ---: |
| 全项目 | 90% | 90% | 90% | 85% |
| P0 核心：glob/security/inventory/materialize/capture/backup/state | 95% | 95% | 95% | 90% |
| commands/git/index | 90% | 90% | 90% | 85% |

阶段 0 启用的覆盖率基线门槛为 Statements 35%、Branches 60%、Functions 45%、
Lines 35%；阶段 1 提升到 Statements 40%、Branches 75%、Functions 50%、Lines 40%；
阶段 2 提升到 Statements 45%、Branches 78%、Functions 58%、Lines 45%。
每完成一个测试阶段只能上调门槛；阶段 4 完成后必须替换为上表的最终门槛，
不能以阶段性基线作为发布标准。

覆盖率只是最低门槛，还必须满足：

- 本文列出的 P0 场景 100% 自动化；
- 新增或修改分支必须有成功和失败测试；
- 不允许仅靠大 snapshot 提升覆盖率；
- 不允许无 issue、无到期时间地 `.skip` 或 quarantine flaky test；
- 同一提交完整 suite 连续运行 20 次无随机失败后，才能将同步/并发关键测试视为稳定；
- 发布分支必须 typecheck、测试、覆盖率和打包检查全部通过。

对于操作系统不可达分支，可通过平台 runner 或可注入 adapter 验证，不应使用 `/* istanbul ignore */` 直接排除安全逻辑。

## 13. 建议 npm scripts 与 CI

建议脚本：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:integration": "vitest run test/integration test/contract --passWithNoTests",
    "test:e2e": "vitest run test/e2e --no-file-parallelism --passWithNoTests",
    "test:coverage": "vitest run --coverage",
    "test:ci": "npm run typecheck && npm run test:coverage && npm run test:e2e"
  }
}
```

最终参数以 Vitest 3 的实际 CLI 支持为准。涉及共享环境变量、端口或 Git remote 的测试应限制并发；其他单元测试保持并行。

CI 建议：

1. **PR fast gate**：Ubuntu + Node 18/20/22，typecheck、unit、integration、coverage。
2. **Platform gate**：macOS/Windows + Node 22，路径、文件系统、Git 和 Extension smoke。
3. **main/nightly**：完整 E2E、20 次稳定性循环、性能和资源测试。
4. **release gate**：所有门禁 + `npm pack --dry-run`，任何 P0 失败禁止发布。

## 14. 实施顺序

### 阶段 0：测试基础设施

- 安装 coverage provider，配置 threshold 和报告格式。
- 建立 temp env、config/state factory、Git fixture、fake Pi API。
- 新增 CI 和 npm scripts。
- 保留现有 76 个测试全部通过。

**退出条件**：本地和 CI 可运行分层测试；测试不访问真实 HOME/网络。

### 阶段 1：P0 纯逻辑

- 补齐 config、glob/path、security、inventory 13 类矩阵、validate、state。
- 解决生产 glob matcher 与孤立 `src/minimatch.ts` 的重复测试问题。

**退出条件**：路径逃逸、hard deny、secret、三方分类和 state 提前更新风险均有回归测试。

### 阶段 2：文件变更与恢复

- 补齐 capture、materialize、backup、rollback、lock。
- 引入稳定失败注入，验证部分失败后的完整恢复。

**退出条件**：create/update/delete、mode、symlink、并发和第 N 步失败全部覆盖。

### 阶段 3：Git 与命令链路

- 补齐真实 Git remote、FF/diverge/rebase/conflict/continue。
- 覆盖 status/diff/capture/apply/pull/push/init。
- 补齐 package reconciliation 和参数注入测试。

**退出条件**：所有命令 P0 顺序、停止点、state 与 reload 规则有断言。

### 阶段 4：Extension、E2E 与平台

- fake Pi API 契约测试。
- 两设备 E2E、故障恢复、bootstrap 和 npm pack。
- macOS/Windows runner、nightly 稳定性和性能测试。

**退出条件**：达到覆盖率门槛，本文 P0/P1 用例全部自动化，连续运行无 flaky failure。

## 15. 完成定义

“完整测试”完成需同时满足：

- [ ] 现有测试无回归，新增 P0/P1 用例全部通过；
- [ ] 13 种三方比较分类均有明确断言；
- [ ] 所有 hard deny、路径逃逸和 secret push 拦截均有测试；
- [ ] apply 中途失败可以自动恢复，且 state 不提前更新；
- [ ] fast-forward、divergence、rebase conflict 和 `push --continue` 全部覆盖；
- [ ] 两个实例并发同步仅一个获得锁；
- [ ] package 安装失败不标记完整成功；
- [ ] Extension 参数路由、确认、通知和 reload 生命周期覆盖；
- [ ] 自定义 `PI_CODING_AGENT_DIR` 和 Node.js 18/20/22 覆盖；
- [ ] Ubuntu、macOS、Windows 的约定矩阵通过；
- [ ] 全局及 P0 模块达到覆盖率阈值；
- [ ] CI、nightly 和 release gate 生效；
- [ ] 测试全程不读取/修改真实用户配置、不依赖公网、不包含真实 secret。
