# 测试实施进度

> 最后更新：2026-07-26  
> 总体状态：阶段 0、1、2 已完成；阶段 3 已完成。

本文件记录 `docs/test-plan.md` 的实际落地状态，供后续会话续作和发布前检查使用。

## 已完成

### 阶段 0：测试基础设施

- 已安装 `@vitest/coverage-v8`，配置 V8 覆盖率报告、HTML/JSON 输出与渐进式阈值。
- 已新增 npm scripts：`test:unit`、`test:integration`、`test:e2e`、`test:coverage`、`test:ci`。
- 已建立测试 helpers：
  - `test/helpers/temp-env.ts`：隔离 HOME、`PI_CODING_AGENT_DIR`、Git config、PATH 和临时目录。
  - `test/helpers/factories.ts`：config/state factory。
  - `test/helpers/git-fixture.ts`：本地 bare remote 与双 clone fixture。
  - `test/helpers/fake-pi.ts`：Pi Extension/API fake。
  - `test/helpers/failure-injection.ts`：确定性失败注入器。
- 已新增 `.github/workflows/test.yml`：Linux Node 18/20/22、
  macOS/Windows smoke、npm package 内容检查。

### 阶段 1：P0 纯逻辑与状态测试

新增：

- `test/config-v2.test.ts`
- `test/glob.test.ts`
- `test/security-p0.test.ts`
- `test/inventory.test.ts`
- `test/validate.test.ts`
- `test/state.test.ts`

覆盖：schema v2、Windows/UNC/遍历路径、hard deny、secret 扫描、14 组三方比较状态、
JSON/冲突 marker/settings 可移植性、state 原子写入与 v1 迁移。

同时修复：Windows 盘符路径校验、配置字段类型校验、`validateFiles` 路径边界、state 原子保存。

### 阶段 2：文件变更、恢复与锁

新增：

- `test/capture.test.ts`
- `test/backup.test.ts`
- `test/materialize-safety.test.ts`
- `test/lock-recovery.test.ts`

覆盖：capture 的新增/删除/冲突、backup/restore 的覆盖/新建/删除/mode/损坏数据、
materialize 的路径遍历与 symlink 防护、并发锁竞争、stale/malformed lock、owner/timeout。

同时修复：stale/malformed lock 恢复、materialize/readAgentFile 的安全路径边界、
verifyCapture 安全路径、backup/restore 的路径/缺失数据/hash 校验。

## 阶段 3：已完成

目标：真实本地 Git remote、命令工作流与 package reconciliation。

新增且通过的测试文件：

- `test/git-remote.test.ts` (2 tests)
  - 本地 bare remote 的 fetch、fast-forward pull、ahead/behind、divergence、Git diff 文件状态。
- `test/packages-reconcile.test.ts` (6 tests)
  - fake `pi` CLI 的 argv 传递、来源更新 remove/install、失败安装结果、
    CLI 不可用/version 失败、settings 中缺少 packages 字段、已安装 package 不重复安装。
- `test/commands-pull.test.ts` (2 tests)
  - agent 未 capture 本地修改时拒绝 pull；remote-only 变更的
    fetch → fast-forward → materialize → state 更新。
- `test/commands-push.test.ts` (12 tests)
  - 完整 push 流程（capture → commit → fetch → rebase → push → apply）、
    无变化 push、双边冲突拦截（rebase conflict 检测）、secret scan 拦截、
    validation 错误诊断、rebase 冲突 + pending operation、
    push --continue（无 pending/unmerged paths/工作树脏/成功继续）、
    自定义 commit message、远端不可达优雅失败。
- `test/commands-status-diff.test.ts` (8 tests)
  - status：无配置、仓库信息、本地变更、远端 ahead/behind、无 origin remote。
  - diff：无配置、文件比较 + git status + remote diff、无 remote 优雅降级。
- `test/ui.test.ts` (19 tests)
  - formatGitStatus（clean/dirty/rebase/merge/无remote）、
    formatComparisonDiff（空/多种变更/仅 no_change）、
    formatSyncStatusV2（完整/含 pending/packages diff）、
    formatSecretsFindings（多项/空）、formatValidationErrors（error/warning/空）、
    formatCaptureResult（capture/delete/denied/conflict/空）。

## 当前质量基线

当前完整验证：

```text
npm run typecheck       passed
npm test                32 files, 268 tests passed
npm run test:coverage   Statements/Lines 80.96%, Branches 78.08%, Functions 90.38%
```

当前渐进式覆盖率门槛：

| 指标 | 阈值 | 实际 |
| --- | ---: | ---: |
| Statements | 45% | 73.5% |
| Branches | 78% | 80.01% |
| Functions | 58% | 92.76% |
| Lines | 45% | 73.5% |

最终目标仍以 `docs/test-plan.md` 的阶段 4 门槛为准；
阶段性阈值只能上调。

## 阶段 4：已完成

目标：Extension 契约、两设备 E2E、bootstrap 验证。

新增且通过的测试文件：

- `test/extension.test.ts` (21 tests)
  - Extension 注册：pisync/debug:clear-repo 命令、session_start/shutdown 事件、status 清理。
  - 参数路由：empty/unknown → menu、status/diff → 输出、
    init/init --force → 交互式输入/取消、push --continue → 参数转发。
  - 交互确认：debug:clear-repo 取消/确认、push 确认流程。
  - reload 生命周期：push 成功后 reload、失败/无变更不 reload。
  - rpc 模式菜单 → select 路由。
- `test/e2e/two-device-sync.test.ts` (2 tests)
  - 完整 round-trip：A push → B clone + pull + apply → 内容验证 → no-op push/pull。
  - 双边冲突：A push → B 改同一文件 → push 检测冲突、B agent 未被修改。
- `test/bootstrap.test.ts` (6 tests)
  - bash 语法检查 (-n)、必要命令/安全模式验证。
  - git/pi 缺失时优雅退出、fake git/pi 完整 bootstrap 流程。
  - 无 URL 时提示输入、空输入退出。

阶段 4 完成时完整验证：

```text
npm run typecheck       passed
npm test                31 files, 264 tests passed
npm run test:coverage   Lines 82.88%, Branches 80.53%, Functions 92.61%
npm run test:ci         passed (typecheck + coverage + e2e)
```

## 后续顺序

1. ✅ 完成阶段 3 剩余 Git、push/rebase 与命令工作流测试，并重新运行全量验证。
2. ✅ 阶段 4：Extension 契约、两设备 E2E、bootstrap 测试已完成。
3. 可选后续：平台 matrix（macOS/Windows runner）、nightly 稳定性测试、覆盖率提升到最终门槛。
4. 达到测试计划中 P0/P1、覆盖率和 CI 的完成定义后，再进行发布准备。
