# pi-git-sync 架构与逻辑文档

> 版本：0.2.x（config schema v2，state schema v3）  
> 最后更新：2026-07-27

## 目录

1. [概述](#1-概述)
2. [项目结构](#2-项目结构)
3. [核心数据模型](#3-核心数据模型)
4. [模块架构](#4-模块架构)
5. [路径与安全层](#5-路径与安全层)
6. [同步锁](#6-同步锁)
7. [同步状态与基线](#7-同步状态与基线)
8. [三方比较引擎](#8-三方比较引擎)
9. [核心流程](#9-核心流程)
10. [安全机制](#10-安全机制)

---

## 1. 概述

pi-git-sync 是一个 Pi 扩展，通过 **Git 私有仓库** 在多台机器之间同步 Pi 配置。核心模型为：

> **单一配置分支 + root 镜像目录 + Glob 白名单 + 同步基线三方比较**

```
┌─────────────┐      push/pull       ┌──────────────┐
│  Machine A  │ ◄──────────────────► │  GitHub Repo │
│  (Pi agent) │                      │  (Private)   │
└─────────────┘                      └──────────────┘
                                            ▲
┌─────────────┐                             │
│  Machine B  │ ◄───────────────────────────┘
│  (Pi agent) │
└─────────────┘
```

### 关键设计决策

| 决策 | 说明 |
| ------ | ------ |
| `settings.json` 整文件共享 | 不做 key-level merge，所有设备用同一份 |
| 仓库不作为 Pi Package 安装 | 避免 Extension/Skill 重复加载 |
| 单向 mirror（`sync/` ↔ agent dir） | 相同相对路径，Git diff 直观 |
| 三方比较（Baseline / Local / Remote） | 识别创建、删除、双边冲突；可快进设备分支自动合入 |
| 仅 fast-forward pull | 有分叉就停止，不自动合并 |
| push 链: capture → commit → rebase → push → apply | 确保 rebase 后 agent 与 repo 一致 |

---

## 2. 项目结构

```
pi-git-sync/
├── index.ts                  # Extension 入口：注册命令、事件、TUI
├── package.json
├── scripts/
│   └── bootstrap.sh          # 新机器自举脚本
├── src/
│   ├── commands.ts           # /pisync 命令路由 + push/pull/init 完整流程
│   ├── config.ts             # pi-sync.json schema v2 加载 & 校验
│   ├── inventory.ts          # 三方文件比较引擎（baseline vs local vs remote）
│   ├── capture.ts            # agent → repo 变更捕获
│   ├── materialize.ts        # repo → agent 文件写入（原子 + 安全）
│   ├── git.ts                # Git 操作封装（status/fetch/pull/push/rebase）
│   ├── backup.ts             # 备份 & 恢复（apply 前完整备份）
│   ├── lock.ts               # 并发锁（pid 级，含 staleness 检测）
│   ├── security.ts           # hard deny 列表 + secret scanning
│   ├── glob.ts               # minimatch glob + 路径规范化 + 安全检查
│   ├── state.ts              # 同步基线持久化（<config-repo>/.pi-sync/state.json，Git ignored）
│   ├── packages.ts           # settings.json packages[] 解析、审批、执行与回滚
│   ├── path-safety.ts        # repo/agent root 与 symlink 边界
│   ├── operation-result.ts   # 结构化命令结果
│   ├── doctor.ts             # 环境诊断（git/ssh/portability）
│   ├── validate.ts           # JSON / conflict marker / settings 可移植性校验
│   ├── settings.ts           # v1 遗留（deepMerge/deepEqual）
│   ├── ui.ts                 # 格式化输出（status/diff/backup/capture）
│   └── minimatch.ts          # 独立 minimatch 实现（备用）
└── test/
    ├── helpers/              # temp-env, git-fixture, fake-pi, factories
    ├── e2e/                  # 两设备端到端测试
    ├── *.test.ts             # 33 个测试文件，282 个测试
    └── ...
```

---

## 3. 核心数据模型

### 3.1 三方比较模型

每次同步操作比较三个状态：

```
┌──────────────────────────────────────────┐
│                三方比较                    │
│                                          │
│   B = Baseline (state.json)              │
│   L = Local    (agent 文件)               │
│   R = Remote   (repo sync/ 文件)          │
│                                          │
│   "不存在" 也作为一种值参与比较           │
└──────────────────────────────────────────┘
```

### 3.2 13 种变更分类

```mermaid
graph TD
    B[Baseline 存在?] -->|是| BA["L? R?"]
    B -->|否| BB["L? R?"]
    
    BA -->|"L=B,R=B"| no_change["no_change: 无变化"]
    BA -->|"L≠B,R=B"| local_only["local_only: 可 capture"]
    BA -->|"L=B,R≠B"| remote_only["remote_only: 可 apply"]
    BA -->|"L≠B,R≠B,L=R"| converged["converged: 自然收敛"]
    BA -->|"L≠B,R≠B,L≠R"| both_mod["both_modified: 冲突！"]
    BA -->|"L不存在,R=B"| local_del["local_deleted"]
    BA -->|"L=B,R不存在"| remote_del["remote_deleted"]
    BA -->|"L不存在,R不存在"| both_del["both_deleted"]
    BA -->|"L≠B,R不存在"| LmodRdel["local_modified_remote_deleted"]
    BA -->|"L不存在,R≠B"| LdelRmod["local_deleted_remote_modified"]
    
    BB -->|"L存在,R不存在"| local_created["local_created"]
    BB -->|"L不存在,R存在"| remote_created["remote_created"]
    BB -->|"L存在,R存在,L=R"| converged
    
    style both_mod fill:#f66
    style LmodRdel fill:#f66
    style LdelRmod fill:#f66
```

### 3.3 同步基线 (state.json)

```json
{
  "schemaVersion": 3,
  "repoPath": "/Users/xxx/.pi/config-repo",
  "branch": "main",
  "lastSyncedCommit": "abc123...",
  "lastSyncedAt": "2026-07-26T00:00:00Z",
  "files": {
    "settings.json": { "sha256": "...", "mode": 420 },
    "prompts/welcome.md": { "sha256": "...", "mode": 420 }
  },
  "pendingOperation": null,
  "lastBackup": "2026-07-26T00-00-00Z",
  "migrationReport": {
    "fromSchema": 2,
    "reconciled": [],
    "removed": [],
    "conflicts": []
  }
}
```

v2 → v3 迁移会先备份旧 state。只有 local/repo hash 相同的路径会自动写入新 baseline；
两边都不存在的路径会移除。差异、不可用路径和 symlink 会保留旧 baseline，并写入
`migrationReport.conflicts`，等待 doctor/status 引导人工处理。

### 3.4 配置清单 (pi-sync.json)

```json
{
  "schemaVersion": 2,
  "branch": "main",
  "root": "sync",
  "include": ["settings.json", "extensions/**", "skills/**", "prompts/**", "themes/**"],
  "exclude": ["**/.DS_Store", "**/*.tmp"],
  "delete": "tracked",
  "security": { "scanSecretsBeforePush": true }
}
```

---

## 4. 模块架构

```mermaid
graph TB
    subgraph "Extension 层"
        index["index.ts<br/>命令注册 · TUI · 事件"]
    end

    subgraph "命令编排层"
        commands["commands.ts<br/>push/pull/init/status/diff/<br/>capture/rollback/doctor"]
    end

    subgraph "核心引擎层"
        inventory["inventory.ts<br/>三方比较"]
        capture["capture.ts<br/>agent → repo"]
        materialize["materialize.ts<br/>repo → agent"]
    end

    subgraph "Git 层"
        git["git.ts<br/>fetch/pull/push/rebase/<br/>status/commit"]
    end

    subgraph "安全与校验层"
        security["security.ts<br/>hard deny + secret scan"]
        glob["glob.ts<br/>minimatch + path 安全"]
        validate["validate.ts<br/>JSON/conflict/portability"]
        lock["lock.ts<br/>并发锁"]
    end

    subgraph "状态与持久化层"
        state["state.ts<br/>基线持久化"]
        backup["backup.ts<br/>备份恢复"]
        config["config.ts<br/>pi-sync.json 校验"]
    end

    subgraph "辅助层"
        packages["packages.ts<br/>package reconcile"]
        doctor["doctor.ts<br/>环境诊断"]
        ui["ui.ts<br/>格式化输出"]
    end

    index --> commands
    commands --> inventory
    commands --> capture
    commands --> materialize
    commands --> git
    commands --> backup
    commands --> lock
    commands --> security
    commands --> validate
    commands --> state
    commands --> config
    commands --> packages
    commands --> doctor

    inventory --> glob
    inventory --> state
    capture --> inventory
    capture --> glob
    capture --> security
    materialize --> inventory
    materialize --> glob
    materialize --> security
    materialize --> validate
    
    git --> commands
    backup --> materialize
```

---

## 5. 路径与安全层

### 5.1 路径规范化

```
输入路径                    →  规范化后
========================================
"themes\\dark.json"        →  "themes/dark.json"
"./prompts/hello.md"       →  "prompts/hello.md"
"extensions//foo.ts"       →  "extensions/foo.ts"
"/etc/passwd"              →  ❌ 拒绝（绝对路径）
"../../.ssh/id_rsa"        →  ❌ 拒绝（.. 逃逸）
"C:\\Users\\..."           →  ❌ 拒绝（盘符路径）
"file\0hidden.txt"         →  ❌ 拒绝（NUL 字符）
```

### 5.2 Glob 白名单优先级

```
内置 hard deny  >  manifest exclude  >  manifest include
     ↑                    ↑                    ↑
   最高优先级           次优先级            最低优先级
```

```
┌──────────────────────────────────────────────────┐
│              isPathAllowed(relPath)               │
│                                                  │
│  1. 遍历 BUILTIN_HARD_DENY                       │
│     ├── auth.json → DENIED                       │
│     ├── sessions/** → DENIED                     │
│     ├── **/.env → DENIED                         │
│     └── ...                                      │
│                                                  │
│  2. 检查 include 白名单                           │
│     ├── 匹配 → 继续                               │
│     └── 不匹配 → NOT_IN_INCLUDE (静默跳过)        │
│                                                  │
│  3. 检查 exclude 列表                             │
│     ├── 匹配 → EXCLUDED (静默跳过)                │
│     └── 不匹配 → ALLOWED ✓                       │
└──────────────────────────────────────────────────┘
```

### 5.3 符号链接与 root 边界

`path-safety.ts` 会检查 repo root、sync root、agent 路径以及每一级已存在组件。
root、目录、文件或 dangling symlink 都会阻断操作；不会跟随 symlink，也不会再静默
跳过危险路径。backup、restore、capture、materialize、inventory 和 doctor 共用这一策略。

### 5.4 Hard Deny 列表（不可覆盖）

```
auth.json          sessions/**        trust.json
models-store.json  npm/**             git/**
node_modules/**    .pi-sync/**        **/.env
**/*.pem           **/id_rsa          **/id_ed25519
```

---

## 6. 同步锁

```
┌────────────────────────────────────────┐
│         SyncLock (PID 级别)             │
│                                        │
│  lockfile: .pi-sync/sync.lock          │
│                                        │
│  {                                     │
│    "pid": 12345,                       │
│    "hostname": "macbook",              │
│    "startedAt": "2026-...",            │
│    "operation": "push"                 │
│  }                                     │
│                                        │
│  规则:                                  │
│  • 同一时刻仅一个进程持有锁             │
│  • 持锁进程崩溃 → stale lock 可恢复     │
│  • 非 owner 不能释放他人锁              │
│  • 释放幂等                             │
└────────────────────────────────────────┘
```

---

## 7. 同步状态与基线

```mermaid
stateDiagram-v2
    [*] --> Idle: 初始化/同步完成
    Idle --> CaptureDone: capture
    CaptureDone --> Pushed: push 成功
    Pushed --> Idle: apply + updateState
    Pushed --> ConflictState: rebase 冲突
    ConflictState --> Pushed: git rebase --continue<br/>+ /pisync push --continue
    ConflictState --> Idle: git rebase --abort<br/>+ /pisync doctor
```

---

## 8. 三方比较引擎

```mermaid
flowchart TD
    A[开始 compareFiles] --> B[枚举 agent 目录所有文件]
    A --> C[枚举 repo sync/ 目录所有文件]
    B --> D[构建 agentIndex: Map]
    C --> E[构建 repoIndex: Map]
    
    D --> F{收集 allPaths}
    E --> F
    
    G[基线 state.files] --> F
    
    F --> H[遍历每个路径]
    H --> I["classifyChange(baseline, local, remote)"]
    I --> J{比较 SHA-256}
    
    J -->|"L=B, R=B"| K1[no_change]
    J -->|"L≠B, R=B"| K2[local_only]
    J -->|"L=B, R≠B"| K3[remote_only]
    J -->|"L≠B, R≠B, L=R"| K4[converged]
    J -->|"L≠B, R≠B, L≠R"| K5[both_modified ⚠]
    J -->|"B不存在, L存在"| K6[local_created]
    J -->|"B不存在, R存在"| K7[remote_created]
    J -->|"B存在, L不存在, R=B"| K8[local_deleted]
    J -->|"B存在, L=B, R不存在"| K9[remote_deleted]
    
    H --> L[排序: 冲突优先, 然后按路径]
    L --> M[生成 summary 统计]
    M --> N[返回 InventoryResult]
```

---

## 9. 核心流程

### 9.1 Push 全链路

```mermaid
sequenceDiagram
    participant A as Agent (local)
    participant R as Repo (working tree)
    participant G as Git (local)
    participant O as Origin (remote)

    Note over A,O: /pisync push

    A->>R: ① capture<br/>agent 变更 → repo 工作树
    R->>R: ② 校验白名单内容<br/>validateFiles()
    R->>R: ③ Secret scan<br/>（完整文件 + staged diff）
    R->>G: ④ git commit<br/>创建本地 commit
    G->>O: ⑤ git fetch origin
    O-->>G: 远端最新 refs
    
    alt 远端有前进
        G->>G: ⑥ git rebase origin/<config.branch>
        
        alt rebase 冲突
            G-->>A: ⚠ 停止！记录 pendingOperation
            Note over A,O: 用户手动解决冲突<br/>git add + rebase --continue<br/>/pisync push --continue
        else rebase 成功
            G->>O: ⑦ git push origin/<config.branch>
            O-->>G: push OK
            G->>A: ⑧ apply<br/>新 HEAD → agent
            A->>A: ⑨ 更新 state baseline
            A->>A: ⑩ reconcile packages
            A->>A: ctx.reload()
        end
    else 无远端变化
        G->>O: ⑦ git push origin/<config.branch>
        O-->>G: push OK
        G->>A: ⑧ apply → ⑨ updateState → ⑩ reload
    end
```

### 9.2 Pull 流程

```mermaid
sequenceDiagram
    participant A as Agent
    participant R as Repo
    participant O as Origin

    Note over A,O: /pisync pull

    A->>A: ① acquire lock
    
    A->>R: ② 检查 repo 状态<br/>(rebase/merge? dirty?)
    R-->>A: clean ✓
    
    A->>A: ③ compareFiles()<br/>检查 agent 是否有未捕获修改
    
    alt 有本地修改
        A-->>A: ⚠ 停止！提示先 push
    else 无本地修改
        R->>O: ④ git fetch origin
        O-->>R: 远端 refs
        
        R->>R: ⑤ isDiverged()?
        
        alt 分叉
            R-->>A: ⚠ 停止！提示手动处理
        else 可 fast-forward
            R->>R: ⑥ git pull --ff-only
            R->>A: ⑦ planMaterialize + executeMaterialize
            A->>A: ⑧ 更新 state baseline
            A->>A: ⑨ reconcile packages
            A->>A: ctx.reload()
        end
    end
```

### 9.3 Package 审批与执行流程

```text
preparePackagePlan
  → 检查新增/变更 source 是否已审批
  → 未审批：返回 approval_required，不执行 pi install/remove
  → 创建备份并 materialize settings.json
  → executePackagePlan（execFile argv）
  → 安装失败：逆序移除变更 package，尝试恢复旧 source
  → 回滚失败：记录 rollbackErrors 和 apply-failed pendingOperation
  → 成功后保存 state 与 trust store，最后 reload
```

### 9.4 Capture 流程

```mermaid
flowchart TD
    A[captureChanges] --> B[compareFiles<br/>生成 InventoryResult]
    B --> C{是否有双边冲突?}
    C -->|是| D[返回 CaptureResult<br/>hasConflicts=true]
    C -->|否| E[getCapturableFiles<br/>过滤 local_only/local_created/local_deleted]
    E --> F[遍历每个文件]
    F --> G{isDenied?}
    G -->|是| H[加入 denied 列表]
    G -->|否| I{isPathAllowed?}
    I -->|否| J[静默跳过]
    I -->|是| K{changeType?}
    K -->|local_deleted| L["unlink(repoFile)<br/>加入 deleted 列表"]
    K -->|local_only/local_created| M["readFile(agent) → writeFile(repo)<br/>加入 captured 列表"]
    H --> F
    J --> F
    L --> F
    M --> F
    F --> N[返回 CaptureResult]
```

### 9.5 Materialize 流程

```mermaid
flowchart TD
    A[planMaterialize] --> B[compareFiles]
    B --> C{有双边冲突?}
    C -->|是| D["plan.conflicts = [...]<br/>plan.blocked = true"]
    C -->|否| E[getApplicableFiles]
    E --> F[遍历每个文件]
    F --> G{isDenied?}
    G -->|是| H[跳过]
    G -->|否| I{changeType?}
    I -->|remote_created/remote_only| J["验证冲突标记<br/>验证 JSON<br/>验证 settings 可移植性<br/>→ toWrite"]
    I -->|remote_deleted/both_deleted| K{"delete=='tracked'<br/>且基线中有此文件?"}
    K -->|是| L["→ toDelete"]
    K -->|否| M[跳过]
    I -->|converged| N[仅更新基线,不写入]
    J --> F
    L --> F
    M --> F
    N --> F
    F --> O["返回 MaterializePlan<br/>blocked = 有 validation error<br/>或有 conflicts"]
    
    O --> P[executeMaterialize]
    P --> Q[遍历 toWrite]
    Q --> R[atomicWrite:<br/>tmpFile → fsync → rename]
    P --> S[遍历 toDelete]
    S --> T["unlink(agentFile)"]
    R --> U[返回 MaterializeResult]
    T --> U
```

### 9.6 Init 流程

```mermaid
flowchart TD
    A["/pisync init [url]"] --> B{仓库已存在?}
    B -->|是| C{--force?}
    C -->|是| D["rm -rf repo<br/>重新 clone"]
    C -->|否| E["fetch + pull<br/>apply 当前配置<br/>返回 'Already initialized'"]
    D --> F[clone]
    B -->|否| F
    
    F --> G{clone 成功?}
    G -->|失败| H[返回错误]
    G -->|成功| I{仓库状态?}
    
    I -->|空仓库| J[scaffold config schema v2]
    I -->|已有合法配置| K[fetch + pull + apply]
    I -->|有提交但无 pi-sync.json| L["返回 'invalid' 错误<br/>提示使用 --force"]
    
    J --> M["创建目录:<br/>sync/ + extensions/ skills/ prompts/ themes/"]
    M --> N["写入 pi-sync.json (v2)<br/>写入 sync/settings.json<br/>写入 .gitignore"]
    N --> C1["以脚手架创建临时基线<br/>capture 当前本地配置"]
    C1 --> O["git commit + push"]
    O --> P{push 成功?}
    P -->|是| K
    P -->|否| Q["返回 warning<br/>scaffold 已 commit 本地"]
    
    K --> R["updateState(repoPath)<br/>ctx.reload()"]
```

### 9.7 Push --Continue 流程

```mermaid
flowchart TD
    A["/pisync push --continue"] --> B{state.pendingOperation<br/>== 'push-rebase-conflict'?}
    B -->|否| C["返回 'No pending operation'"]
    B -->|是| D[acquire lock]
    D --> E{hasUnmergedPaths?}
    E -->|是| F["返回 '仍有未合并路径'<br/>提示先 git add + rebase --continue"]
    E -->|否| G{isWorktreeClean?}
    G -->|否| H["返回 '工作树不干净'<br/>提示先 commit 或 stash"]
    G -->|是| I[validateFiles]
    I --> J{validation.blocked?}
    J -->|是| K[返回 validation 错误]
    J -->|否| L{scanSecretsBeforePush?}
    L -->|是| M[secret scan]
    M --> N{发现 secret?}
    N -->|是| O[返回 secret 警告]
    N -->|否| P[git push]
    L -->|否| P
    P --> Q[apply + updateState<br/>pendingOperation = null]
    Q --> R["ctx.reload()"]
```

---

## 10. 安全机制

```mermaid
graph LR
    subgraph "防御层 1: Hard Deny"
        A["内置不可覆盖黑名单<br/>auth.json, sessions/, .env,<br/>*.pem, id_rsa, ..."]
    end
    
    subgraph "防御层 2: Path Safety"
        B["路径规范化<br/>拒绝 .. 逃逸<br/>拒绝绝对路径<br/>拒绝 NUL 字符<br/>拒绝符号链接"]
    end
    
    subgraph "防御层 3: Content Validation"
        C["JSON 格式校验<br/>冲突标记检测<br/>settings.json 可移植性<br/>package source 格式"]
    end
    
    subgraph "防御层 4: Secret Scan"
        D["push 前扫描<br/>完整文件 + staged diff<br/>GitHub token, API key,<br/>JWT, 私钥头"]
    end
    
    subgraph "防御层 5: Backup & Rollback"
        E["apply 前完整备份<br/>原子写入 (tmp+rename)<br/>失败自动回滚<br/>多文件恢复"]
    end
    
    subgraph "防御层 6: Concurrency"
        F["PID 级别锁<br/>stale lock 检测<br/>非 owner 不可释放"]
    end
    
    A --> B --> C --> D --> E --> F
```

### 原子写入流程

```
┌───────────────────────────────────────────┐
│          atomicWrite(targetPath, content)  │
│                                           │
│  1. mkdir(dirname(targetPath))            │
│  2. tmpPath = ".file.XXXX.tmp"            │
│     (同目录，确保 rename 原子性)           │
│  3. writeFile(tmpPath, content, mode)     │
│  4. rename(tmpPath, targetPath)           │
│     └─ 失败 → unlink(tmpPath)             │
│  5. 抛出错误或成功返回                     │
└───────────────────────────────────────────┘
```

### Backup & Rollback

```
┌──────────────────────────────────────────┐
│  apply 前: createBackup()                │
│                                          │
│  备份目录: <config-repo>/.pi-sync/backups/<timestamp>/ │
│  ├── backup.json  (清单)                 │
│  └── data/                               │
│      ├── prompts/welcome.md              │
│      └── ...                             │
│                                          │
│  清单记录:                                │
│  • backed_up:   将被覆盖的文件 (含内容)    │
│  • will_create: 将被新建的文件 (标记)     │
│  • will_delete: 将被删除的文件 (含内容)    │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  rollback: restoreBackup()               │
│                                          │
│  1. 先备份当前状态 (pre-rollback)         │
│  2. 恢复 backed_up 文件 → 原子写入        │
│  3. 恢复 will_delete 文件 → 原子写入      │
│  4. 删除 will_create 文件 → unlink       │
│  5. hash 校验失败 → 拒绝恢复              │
│  6. 数据文件缺失 → 拒绝恢复               │
└──────────────────────────────────────────┘
```

---

## 附录 A: Git 仓库结构

```
<user>-pi-config/                  # GitHub Private Repo
├── .gitignore
├── pi-sync.json                  # 同步配置 (config schema v2)
├── .pi-sync/                     # 本机 state、备份与锁（Git ignored）
└── sync/                         # 所有同步内容
    ├── settings.json              # 共享 settings (整文件)
    ├── AGENTS.md                  # (可选)
    ├── SYSTEM.md                  # (可选)
    ├── APPEND_SYSTEM.md           # (可选)
    ├── keybindings.json           # (可选)
    ├── extensions/                # 自定义扩展
    ├── skills/                    # Skills
    ├── prompts/                   # Prompt 模板
    └── themes/                    # 主题
```

## 附录 B: 命令参考

| 命令 | 锁 | 网络 | 副作用 | 说明 |
| ------ | :--: | :----: | :------: | ------ |
| `/pisync` | - | - | - | TUI 交互菜单 |
| `/pisync init [url]` | ✅ | ✅ | clone/commit/push/apply/reload | 初始化或克隆配置仓库 |
| `/pisync status` | - | - | - | 显示三方比较 + git 状态 |
| `/pisync diff` | - | 可选 | - | 显示各类差异 |
| `/pisync pull` | ✅ | ✅ | fetch/ff/apply/reload | 拉取远端变更 |
| `/pisync push` | ✅ | ✅ | capture/commit/rebase/push/apply/reload | 推送本地变更 |
| `/pisync push --continue` | ✅ | ✅ | validate/scan/push/apply/reload | 继续冲突解决后的推送 |
| `/pisync capture` | ✅ | - | agent → repo 文件复制 | 仅捕获，不 commit/push |
| `/pisync doctor` | - | - | - | 环境诊断 |
| `/pisync rollback` | ✅ | - | 备份恢复/reload | 回滚到上一个备份 |
| `debug:clear-repo` | ✅ | ✅ | 清空本地+远端/reload | 🔴 仅调试用 |

## 附录 C: 数据流总览

```mermaid
graph LR
    subgraph "Agent 目录"
        AD["~/.pi/agent/<br/>settings.json<br/>extensions/<br/>skills/<br/>prompts/<br/>themes/"]
    end
    
    subgraph "Config Repo"
        CR["~/.pi/config-repo/<br/>pi-sync.json<br/>sync/<br/>  ├── settings.json<br/>  ├── extensions/<br/>  ├── skills/<br/>  ├── prompts/<br/>  └── themes/"]
    end
    
    subgraph "Config Repo 本机状态（Git ignored）"
        ST[".pi-sync/<br/>  ├── state.json<br/>  ├── sync.lock<br/>  └── backups/"]
    end
    
    AD <-.->|"capture / materialize"| CR
    CR --- ST
    CR <-.->|"git push / pull"| GitHub
```
