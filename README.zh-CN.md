# ufoo

[English](README.md)

🤖 多Agent AI 协作框架，支持 Claude Code、OpenAI Codex 和自定义 AI Agent 的编排协作。

📦 **npm**: [https://www.npmjs.com/package/u-foo](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## 为什么选择 ufoo？

ufoo 解决多 AI 编程 Agent 协同工作的难题：

- **🔗 统一界面** - 一个聊天 UI 管理所有 AI Agent
- **📬 消息路由** - Agent 之间通过事件总线通信协作
- **🧠 上下文共享** - 跨 Agent 共享决策和知识
- **🚀 自动初始化** - Agent 包装器自动完成配置
- **📝 决策追踪** - 记录架构决策和权衡取舍
- **⚡ 实时更新** - 即时查看 Agent 状态和消息

## 功能特性

- **聊天界面** - 交互式多 Agent 聊天 UI (`ufoo chat`)
  - 实时 Agent 通信和状态监控
  - 仪表盘展示 Agent 列表、在线状态和快捷操作
  - 使用 `@agent-name` 向特定 Agent 发送消息
- **事件总线** - Agent 间实时消息通信 (`ufoo bus`)
- **上下文共享** - 共享决策和项目上下文 (`ufoo ctx`)
- **Agent 包装器** - Claude Code (`uclaude`)、Codex (`ucodex`) 和 ucode 助手 (`ucode`) 自动初始化
  - **PTY 包装器** - 智能终端模拟与就绪检测
  - **智能探针注入** - 等待 Agent 初始化完成后再注入命令
  - **统一命名** - 一致的 Agent 命名规范（如 ucode-1、claude-1、codex-1）
- **技能系统** - 可扩展的 Agent 能力 (`ufoo skills`)

## 安装

```bash
# 从 npm 全局安装（推荐）
npm install -g u-foo
```

或从源码安装：

```bash
git clone https://github.com/Icyoung/ufoo.git ~/.ufoo
cd ~/.ufoo && npm install && npm link
```

安装后可使用以下全局命令：`ufoo`、`uclaude`、`ucodex`、`ucode`。

## 快速开始

```bash
# 初始化项目
cd your-project
ufoo init

# 启动聊天界面（默认命令）
ufoo chat
# 或直接
ufoo

# 使用 Agent 包装器（自动初始化 + 加入总线）
uclaude   # Claude Code 包装器
ucodex    # Codex 包装器
ucode     # ucode 助手（自研 AI 编程 Agent）
```

## 示例工作流

```bash
# 1. 启动聊天界面
$ ufoo

# 2. 从聊天中启动 Agent
> /launch claude
> /launch ucode

# 3. 向 Agent 发送任务
> @claude-1 请分析当前代码库结构
> @ucode-1 修复认证模块的 bug

# 4. Agent 通过总线通信
claude-1: 分析完成，发现 3 处需要重构...
ucode-1: Bug 已修复，正在运行测试...

# 5. 查看已做的决策
> /decisions
```

原生自研实现位于 `src/code` 目录。

准备和验证 `ucode` 运行时：

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build
```

尝试原生核心队列运行时（开发中）：

```bash
ucode-core submit --tool read --args-json '{"path":"README.md"}'
ucode-core run-once --json
ucode-core list --json
```

## Agent 配置

在 `.ufoo/config.json` 中配置 AI 提供商：

### ucode 配置（自研助手）
```json
{
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-4-turbo-preview",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-***"
}
```

### Claude 配置
```json
{
  "claudeProvider": "claude-cli",
  "claudeModel": "claude-3-opus"
}
```

### Codex 配置
```json
{
  "codexProvider": "codex-cli",
  "codexModel": "gpt-4"
}
```

### 完整示例
```json
{
  "launchMode": "internal",
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-4-turbo-preview",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-***",
  "claudeProvider": "claude-cli",
  "claudeModel": "claude-3-opus",
  "codexProvider": "codex-cli",
  "codexModel": "gpt-4"
}
```

`ucode` 会将配置写入全局目录（`~/.ufoo/agent/ucode/config`），用于原生 planner/engine 调用。配置一次，所有项目通用。项目级 `.ufoo/config.json` 可按需覆盖全局配置。

## 架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   uclaude   │     │   ucodex    │     │    ucode    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    ┌──────▼──────┐
                    │  ufoo bus   │  事件总线
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌───▼───┐ ┌──────▼──────┐
       │  .ufoo/bus  │ │context│ │  decisions  │
       └─────────────┘ └───────┘ └─────────────┘
```

Bus 状态存放于 `.ufoo/agent/all-agents.json`（元数据）、`.ufoo/bus/*`（队列/事件）以及 `.ufoo/daemon/*`（bus daemon 运行态）。

## 命令列表

### 核心命令
| 命令 | 说明 |
|------|------|
| `ufoo` | 启动聊天界面（默认） |
| `ufoo chat` | 启动交互式多 Agent 聊天 UI |
| `ufoo init` | 在当前项目初始化 .ufoo |
| `ufoo status` | 显示 banner、未读消息和未处理决策 |
| `ufoo doctor` | 检查安装状态 |

### Agent 管理
| 命令 | 说明 |
|------|------|
| `ufoo daemon start` | 启动 ufoo 守护进程 |
| `ufoo daemon stop` | 停止 ufoo 守护进程 |
| `ufoo daemon status` | 查看守护进程状态 |
| `ufoo resume [nickname]` | 恢复 Agent 会话 |

### 事件总线
| 命令 | 说明 |
|------|------|
| `ufoo bus join` | 加入事件总线（Agent 包装器自动完成） |
| `ufoo bus send <id> <msg>` | 发送消息给 Agent |
| `ufoo bus check <id>` | 检查待处理消息 |
| `ufoo bus status` | 查看总线状态和在线 Agent |

### 上下文与决策
| 命令 | 说明 |
|------|------|
| `ufoo ctx decisions -l` | 列出所有决策 |
| `ufoo ctx decisions -n 1` | 显示最新决策 |
| `ufoo ctx decisions new <title>` | 创建新决策 |

### 技能
| 命令 | 说明 |
|------|------|
| `ufoo skills list` | 列出可用技能 |
| `ufoo skills show <skill>` | 显示技能详情 |

备注：
- Claude CLI 的 headless agent 使用 `--dangerously-skip-permissions`。

## 项目结构

```
ufoo/
├── bin/
│   ├── ufoo         # 主 CLI 入口 (bash)
│   ├── ufoo.js      # Node 包装器
│   ├── uclaude      # Claude Code 包装器
│   ├── ucodex       # Codex 包装器
│   └── ucode        # ucode 助手包装器
├── SKILLS/          # 全局技能（uinit, ustatus）
├── src/
│   ├── bus/         # 事件总线实现（JS）
│   ├── daemon/      # Daemon + chat bridge
│   ├── agent/       # Agent 启动/运行
│   └── code/        # 原生 ucode 核心实现
├── modules/
│   ├── context/     # 决策/上下文协议
│   ├── bus/         # 总线模块资源
│   └── resources/   # UI/图标（可选）
├── AGENTS.md        # 项目指令（规范文件）
└── CLAUDE.md        # 指向 AGENTS.md
```

## 项目初始化后的目录结构

执行 `ufoo init` 后，你的项目会包含：

```
your-project/
├── .ufoo/
│   ├── bus/
│   │   ├── events/      # 事件日志（只追加）
│   │   ├── queues/      # 每个 Agent 的消息队列
│   │   └── offsets/     # 读取位置跟踪
│   └── context/
│       ├── decisions/   # 决策记录
│       └── decisions.jsonl  # 决策索引
├── AGENTS.md            # 注入的协议块
└── CLAUDE.md            # → AGENTS.md
```

## 聊天界面

交互式聊天 UI 提供集中化的 Agent 管理中心：

### 功能
- **实时通信** - 在一个界面查看所有 Agent 消息
- **Agent 仪表盘** - 监控在线状态、会话 ID 和昵称
- **定向消息** - 使用 `@agent-name` 向特定 Agent 发送消息
- **命令补全** - Tab 键补全命令和 Agent 名称
- **鼠标支持** - `Ctrl+M` 切换鼠标模式（滚动 vs 文本选择）
- **会话历史** - 跨会话持久化消息记录

### 快捷键
| 按键 | 操作 |
|------|------|
| `Tab` | 自动补全命令/Agent |
| `Ctrl+C` | 退出聊天 |
| `Ctrl+M` | 切换鼠标模式 |
| `Ctrl+L` | 清屏 |
| `Ctrl+R` | 刷新 Agent 列表 |
| `↑/↓` | 浏览命令历史 |

### 聊天命令
| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/agents` | 列出在线 Agent |
| `/clear` | 清除聊天记录 |
| `/settings` | 配置聊天偏好 |
| `@agent-name <message>` | 向特定 Agent 发送消息 |

## Agent 通信

Agent 通过事件总线通信：

```bash
# Agent A 向 Agent B 发送任务
ufoo bus send "codex:abc123" "请分析项目结构"

# Agent B 检查并执行
ufoo bus check "codex:abc123"
# → 自动执行任务
# → 回复结果
ufoo bus send "claude-code:xyz789" "分析完成：..."
```

## 技能（供 Agent 使用）

内置技能通过斜杠命令触发：

- `/ubus` - 检查并自动执行待处理消息
- `/uctx` - 快速检查上下文状态
- `/ustatus` - 统一状态视图（横幅、未读消息、未决决策）
- `/uinit` - 手动初始化 .ufoo

## 系统要求

- **macOS** - 用于 Terminal.app/iTerm2 集成
- **Node.js >= 18** - npm 安装和 JavaScript 运行时
- **Bash 4+** - Shell 脚本和命令执行
- **终端** - iTerm2 或 Terminal.app 用于启动 Agent

## Codex CLI 说明

`ufoo chat` 会自动启动守护进程（无需单独运行 `ufoo daemon start`）。

如果 Codex CLI 在 `~/.codex` 下报权限错误（例如 sessions 目录），请设置可写的 `CODEX_HOME`：

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo chat  # 守护进程自动启动
```

## 开发

### 环境搭建
```bash
# 克隆仓库
git clone https://github.com/Icyoung/ufoo.git
cd ufoo

# 安装依赖
npm install

# 本地开发链接
npm link

# 运行测试
npm test
```

### 参与贡献
- Fork 本仓库
- 创建功能分支 (`git checkout -b feature/amazing-feature`)
- 提交更改 (`git commit -m 'Add amazing feature'`)
- 推送分支 (`git push origin feature/amazing-feature`)
- 发起 Pull Request

### 项目结构
- `src/` - 核心 JavaScript 实现
- `bin/` - CLI 入口
- `modules/` - 模块化功能（bus、context 等）
- `test/` - 单元测试和集成测试
- `SKILLS/` - Agent 技能定义

## 许可证

UNLICENSED（私有）
