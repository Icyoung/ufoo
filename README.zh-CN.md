# ufoo

多Agent AI 协作工具包，支持 Claude Code 和 OpenAI Codex。

## 功能特性

- **事件总线** - Agent间实时消息通信 (`ufoo bus`)
- **上下文共享** - 共享决策和项目上下文 (`ufoo ctx`)
- **Agent包装器** - Claude Code (`uclaude`) 和 Codex (`ucodex`) 自动初始化
- **技能系统** - 可扩展的Agent能力 (`ufoo skills`)

## 快速开始

```bash
# 克隆并全局链接
git clone <repo> ~/.ufoo
cd ~/.ufoo && npm link

# 初始化项目
cd your-project
ufoo init

# 或使用Agent包装器（自动初始化 + 加入总线）
uclaude   # 代替 'claude'
ucodex    # 代替 'codex'
```

## 架构

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   uclaude   │     │   ucodex    │     │  其他...    │
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

## 命令列表

| 命令 | 说明 |
|------|------|
| `ufoo init` | 在当前项目初始化 .ufoo |
| `ufoo status` | 显示 banner、未读消息和未处理决策 |
| `ufoo daemon --start|--stop|--status` | 管理 ufoo 守护进程 |
| `ufoo chat` | 启动 ufoo 交互界面（无参数默认进入） |
| `ufoo bus join` | 加入事件总线（uclaude/ucodex 自动完成）|
| `ufoo bus send <id> <msg>` | 发送消息给Agent |
| `ufoo bus check <id>` | 检查待处理消息 |
| `ufoo bus status` | 查看总线状态 |
| `ufoo ctx decisions -l` | 列出所有决策 |
| `ufoo ctx decisions -n 1` | 显示最新决策 |
| `ufoo skills list` | 列出可用技能 |
| `ufoo doctor` | 检查安装状态 |

备注：
- Claude CLI 的 headless agent 使用 `--dangerously-skip-permissions`。

## 项目结构

```
ufoo/
├── bin/
│   ├── ufoo         # 主 CLI 入口 (bash)
│   ├── ufoo.js      # Node 包装器
│   ├── uclaude      # Claude Code 包装器
│   └── ucodex       # Codex 包装器
├── SKILLS/          # 全局技能（uinit, ustatus）
├── src/
│   ├── bus/         # 事件总线实现（JS）
│   ├── daemon/      # Daemon + chat bridge
│   └── agent/       # Agent 启动/运行
├── scripts/         # 历史遗留（bash，已弃用）
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
│   │   ├── queues/      # 每个Agent的消息队列
│   │   └── offsets/     # 读取位置跟踪
│   └── context/
│       └── DECISIONS/   # 决策记录
├── scripts/             # 软链接（历史遗留，可选）
├── AGENTS.md            # 注入的协议块
└── CLAUDE.md            # → AGENTS.md
```

## Agent通信

Agent通过事件总线通信：

```bash
# Agent A 向Agent B 发送任务
ufoo bus send "codex:abc123" "请分析项目结构"

# Agent B 检查并执行
ufoo bus check "codex:abc123"
# → 自动执行任务
# → 回复结果
ufoo bus send "claude-code:xyz789" "分析完成：..."
```

## 技能（供Agent使用）

内置技能通过斜杠命令触发：

- `/ubus` - 检查并自动执行待处理消息
- `/uctx` - 快速检查上下文状态
- `/ustatus` - 统一状态视图（横幅、未读消息、未决决策）
- `/uinit` - 手动初始化 .ufoo

## 系统要求

- macOS（用于 Terminal.app/iTerm2 注入功能）
- Node.js >= 18（可选，用于 npm 全局安装）
- Bash 4+

## Codex CLI 说明

如果 Codex CLI 在 `~/.codex` 下报权限错误（例如 sessions 目录），请在启动 daemon/chat 前设置可写的 `CODEX_HOME`：

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo daemon start
ufoo chat
```

## 开发

```bash
# 本地开发
./bin/ufoo --help

# 或通过 Node
npm link
ufoo --help
```

## 许可证

UNLICENSED（私有）
