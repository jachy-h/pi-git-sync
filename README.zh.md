# pi-git-sync

让每台机器使用相同的 Pi 配置。

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [English](./README.md)

pi-git-sync 将 Pi 配置保存在私有 Git 仓库中，并在多台机器之间同步。

```text
机器 A ── /pisync ──> 私有 Git 仓库 <── /pisync ── 机器 B
```

## 1. 快速开始

### 环境与初始化

- Pi `0.82.1` 或更高版本（Node.js `>=22.19.0`）
- 已安装 Git，并已配置 GitHub SSH 或 HTTPS 凭据

在第一台机器上：

1. 创建一个**空的私有** GitHub 仓库，不要初始化 README。
2. 安装扩展：

   ```bash
   pi install npm:@jachy/pi-git-sync
   ```

3. 运行 `/pisync`，输入仓库 URL。

在其他机器上安装扩展，并使用同一 URL 运行 `/pisync`。

---

😄 **上述内容已经完成多设备同步，下面仅仅是更详细的说明，可忽略。**

---

### 日常使用

| 命令 | 用途 |
| --- | --- |
| `/pisync` | 初始化或执行完整同步 |
| `/pisync status` | 查看 Git 与三方同步状态 |
| `/pisync diff` | 预览待处理差异 |

修改 Pi 配置后运行 `/pisync`。按 `Esc` 可取消同步并终止其 Git/SSH 子进程。

### 同步范围

| 内容 | 行为 |
| --- | --- |
| Extensions、Skills、Prompts、Themes | 从 `sync/` 下对应目录同步 |
| `settings.json` | 整文件同步；本机 `file:` package 仅保留在当前设备 |
| `AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`keybindings.json` | 复制到 Pi agent 目录 |
| 第三方 Packages | 在 `settings.json` 中声明；新增或变更 source 必须审批 |

以下路径始终禁止同步：

```text
auth.json  sessions/**  trust.json  models-store.json  npm/**  git/**
node_modules/**  **/node_modules/**  .pi-sync/**  **/.env  **/*.pem
**/id_rsa  **/id_ed25519
```

隐藏文件（`.gitignore` 除外）会被排除，符号链接不会被跟随。

## 2. 了解更多

### 同步模型

```text
agent 文件
   │
   ├─ 捕获并提交本机改动
   ├─ 获取配置分支
   ├─ 对本地提交 rebase，或对仅远端改动 fast-forward
   ├─ 将结果应用到 Pi
   └─ 推送共享分支与当前设备的恢复分支
```

任一步失败都会停止同步。双方都修改过的文件不会被静默覆盖。

### 仓库与配置

仓库会克隆到本地：

```text
~/.pi/config-repo/
├── pi-sync.json       # 同步配置
└── sync/              # 已同步的 Pi 文件
    ├── settings.json
    ├── extensions/
    ├── skills/
    ├── prompts/
    └── themes/
```

默认的 `~/.pi/config-repo/pi-sync.json`：

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

- 过滤优先级：内置 hard deny > `exclude` > `include`。
- `delete: "tracked"` 只传播已管理文件的删除；`"none"` 不传播删除。
- `pullTimeoutMs` 控制每次 pull、fetch 和 rebase；完整 `/pisync` 最多运行 60 秒。
- 敏感信息扫描默认启用；关闭扫描后，内置 hard deny 仍然生效。

### 冲突与安全

```text
                 仅一侧修改 ──> 自动继续
基线 ───────────┤
                 双方都修改 ──> 应用前询问
```

发生内容冲突时，可以让当前 Pi agent 协助合并、仅对冲突路径选择本机或远端内容，或停止后手动合并。双方的非冲突改动和每台设备的恢复分支都会保留。

其他保护包括原子写入、apply 前备份、操作锁、路径边界检查、package 审批，以及安装失败后的回滚尝试。

### 开发

```bash
# 本地加载，然后在 Pi 中运行 /reload
ln -s $(pwd) ~/.pi/agent/extensions/pi-git-sync

# 或临时加载
pi -e ./index.ts
```

```bash
npm install
npm test           # 完整测试套件，含 E2E
npm run test:core  # 不含 E2E 的核心测试
npm run test:e2e   # 双设备 E2E 测试
npm run test:smoke # 快速 glob 与 UI 检查
npm run test:ci    # 类型检查、覆盖率门禁和 E2E
```

升级后先运行 `/pisync status`，再运行 `/pisync`。迁移、冲突恢复和回滚说明见[升级指南](./docs/upgrade.md)。

## License

MIT
