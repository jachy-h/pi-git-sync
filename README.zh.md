# pi-git-sync

通过 GitHub 私有仓库在多台机器之间同步 Pi 的配置。

[![npm](https://img.shields.io/npm/v/@jachy/pi-git-sync)](https://www.npmjs.com/package/@jachy/pi-git-sync)

📖 [English](./README.md)

---

## 使用方式

### 前置条件

- Pi 已安装
- Git 和 SSH 已配置（用于 GitHub）

### 1. 在 GitHub 创建空私有仓库

创建一个空的私有仓库（例如 `pi-config`），**不要** 勾选 "Initialize with README"。

### 2. 安装 pi-git-sync

```bash
pi install npm:@jachy/pi-git-sync
```

### 3. 一键初始化

在 Pi 中执行，提供你的仓库 URL 即可。pi-git-sync 会自动 clone、生成配置文件结构（scaffold）、提交并推送到远端。

```bash
/pisync init git@github.com:<your-username>/pi-config.git
```

生成的仓库结构：

```text
pi-config/
├── .gitignore
├── package.json              # Pi Package 清单
├── pi-sync.json              # 同步配置
├── extensions/               # 自定义扩展
├── skills/                   # 技能
├── prompts/                  # 提示模板
├── themes/                   # 主题
├── config/
│   ├── settings.shared.json  # 共享设置
│   └── machines/             # 单机覆盖（可选）
└── files/
```

### 4. 导入当前配置

首次使用，把当前本地配置导入仓库：

```bash
/pisync capture
```

然后提交并推送：

```bash
/pisync push
```

---

## 命令

| 命令 | 说明 |
|---|---|
| `/pisync` | TUI 交互菜单 |
| `/pisync status` | 查看同步状态 |
| `/pisync diff` | 查看待应用的差异 |
| `/pisync pull` | 拉取并应用远端更新 |
| `/pisync push` | 提交并推送本地变更 |
| `/pisync apply` | 应用当前仓库版本（离线） |
| `/pisync capture` | 将本地配置导入仓库 |
| `/pisync doctor` | 诊断环境 |
| `/pisync rollback` | 回滚到上一个备份 |

---

## 同步范围

| 内容 | 同步方式 |
|---|---|
| Extensions | Pi 直接从仓库加载 |
| Skills | Pi 直接从仓库加载 |
| Prompts | Pi 直接从仓库加载 |
| Themes | Pi 直接从仓库加载 |
| 共享 Settings | 分层合并（shared → platform → machine） |
| `AGENTS.md`、`SYSTEM.md` | 原子复制到 agent 目录 |
| `keybindings.json` | 原子复制到 agent 目录 |
| 第三方 Packages | 声明依赖，自动安装/更新（不会自动卸载本地 package） |

## 不同步的内容

`auth.json`、`sessions/`、`trust.json`、`models-store.json`、`npm/`、`git/`、`node_modules/`、`.env`、`*.pem`、`id_rsa` 等包含认证信息或可重建的安装产物。

## 配置说明（`pi-sync.json`）

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

## Settings 合并模型

```
settings.shared.json  →  settings.<platform>.json  →  machines/<hostname>.json  →  本机保留字段
```

优先级：`shared < platform < machine < local-only`

## 安全措施

- Pull 默认仅 fast-forward，分叉时停止并提示
- Push 前自动扫描秘密信息（API Key、Token、私钥等）
- 所有配置写入为原子操作（临时文件 → fsync → rename）
- 每次应用前自动创建备份，支持回滚
- 并发锁防止多个 Pi 实例同时同步

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
npm test           # 单次运行
npm run test:watch # 监听模式
npm run typecheck  # 类型检查
```

### 项目结构

```text
pi-git-sync/
├── index.ts              # Extension 入口
├── package.json
├── tsconfig.json
├── scripts/
│   └── bootstrap.sh      # 新机器引导脚本
├── src/
│   ├── commands.ts        # /pisync 命令路由
│   ├── config.ts          # pi-sync.json 解析
│   ├── git.ts             # Git 操作
│   ├── settings.ts        # Settings 分层合并
│   ├── materialize.ts     # 原子文件应用
│   ├── capture.ts         # 本地配置导入仓库
│   ├── backup.ts          # 备份 & 回滚
│   ├── lock.ts            # 并发锁
│   ├── security.ts        # Denylist & 秘密扫描
│   ├── doctor.ts          # 环境诊断
│   ├── state.ts           # 状态持久化
│   ├── packages.ts        # Package reconciliation
│   ├── ui.ts              # 格式化输出
│   └── minimatch.ts       # Glob 匹配
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
