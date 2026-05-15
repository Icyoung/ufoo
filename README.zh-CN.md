# ufoo

[English](README.md)

ufoo 是一个多 Agent 工作区协议，用于在同一个项目运行 Claude Code、OpenAI Codex、ufoo 原生 `ucode`，以及按模板编排的 Agent 小组。

npm 包：[u-foo](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## 功能概览

- `ufoo` / `ufoo chat` 打开交互式多 Agent 仪表盘。
- `uclaude`、`ucodex`、`ucode` 会带着项目 bootstrap、bus 身份和 ufoo 协议上下文启动 Agent。
- `ufoo daemon` 负责项目运行态、启动/恢复、组编排、报告和 chat bridge 请求。
- `ufoo bus` 提供项目内 Agent 消息、唤醒、监听、提醒和终端激活。
- `ufoo ctx`、`ufoo memory`、`ufoo history` 把决策、长期事实和输入时间线写入 `.ufoo/`。
- `ufoo group` 从 `templates/groups/` 的内置模板启动多 Agent 小组。
- `ufoo online` 提供远程 relay、频道、房间、token 和 inbox 辅助命令。

## 环境要求

- Node.js 18 或更新版本。
- macOS，用于 Terminal.app/iTerm2 启动和激活集成。
- 使用 `uclaude` 或 `ucodex` 时，需要本机已经安装 Claude Code 或 Codex CLI。

## 安装

安装 npm 发布包：

```bash
npm install -g u-foo
```

或从源码链接本仓库：

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm link
```

安装后会提供这些命令：`ufoo`、`uclaude`、`ucodex`、`ucode`、`ucode-core`。

## 快速开始

```bash
cd your-project
ufoo init --modules context,bus
ufoo
```

在 chat UI 里启动 Agent：

```text
> /launch claude
> /launch codex
> /launch ucode
> @claude-1 read the project structure and summarize the risks
```

也可以直接从项目目录启动包装器：

```bash
uclaude
ucodex
ucode
```

`ufoo chat` 会按需启动项目 daemon。跨项目全局模式：

```bash
ufoo -g
```

## 架构

```text
                 ufoo chat / ufoo -g
                         |
                         v
        +----------------+----------------+
        | project daemon / IPC / reports  |
        +----------------+----------------+
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
    controller       group runtime   project registry
 gate/router loop    orchestration   ~/.ufoo/projects
          |
          v
  provider API transports and tools
  codex/claude/ucode, memory, bus, terminal
          |
          v
  uclaude / ucodex / ucode agent sessions
```

Chat UI 通过 `.ufoo/run/ufoo.sock` 和项目 daemon 通信。daemon 负责启动、恢复、recover、group 编排、report、controller 路由和项目注册表更新。Agent 通过项目 bus 通信，并可使用共享决策、memory、report、prompt history 和工具处理器。

## 常用命令

### 项目运行态

```bash
ufoo init --modules context,bus,resources
ufoo status
ufoo doctor
ufoo daemon --start
ufoo daemon --status
ufoo daemon --stop
```

`ufoo init` 会创建 `.ufoo/`，向 `AGENTS.md` 和 `CLAUDE.md` 注入 ufoo 协议块，创建 shared memory 存储，并初始化指定模块。默认模块是 `context`；常用多 Agent 项目建议使用 `--modules context,bus`。

### Chat 和 Agent

```bash
ufoo
ufoo chat
ufoo chat -g
ufoo launch codex reviewer --profile review-critic
ufoo solo list
ufoo solo run implementation-lead --agent codex --nickname builder
ufoo role ufoo-builder implementation-lead
ufoo resume <ucode|uclaude|ucodex|nickname>
ufoo recover list
```

常见 chat 命令包括 `/status`、`/bus list`、`/bus status`、`/settings`、`/project list`、`/project switch <index|path>`、`/open <path>`、`/resume list`、`/group status` 和 `@nickname <message>`。

### 事件总线

```bash
ufoo bus join
ufoo bus status
ufoo bus send codex:abc123 "Please implement the approved slice."
ufoo bus check codex:abc123
ufoo bus listen codex:abc123 --from-beginning
ufoo bus alert codex:abc123 --daemon --notify
ufoo bus wake ufoo-builder --reason follow-up
ufoo bus activate ufoo-builder
```

先用 `ufoo bus status` 查看真实 subscriber ID 或可解析昵称。当前项目会给显式 group 昵称加项目前缀，例如 `ufoo-builder`；裸 `builder` 目标不一定能解析。

### 上下文、Memory、Report

```bash
ufoo ctx decisions -l
ufoo ctx decisions -n 1
ufoo ctx decisions new "Adopt API-backed loop architecture"

ufoo memory add "Provider contract" --body "Durable fact..." --tags provider,contract
ufoo memory list --tag provider
ufoo memory show mem-0001

ufoo history build
ufoo history show 20
ufoo history prompt 30

ufoo report start "Implement README refresh" --task docs-readme --agent ufoo-builder
ufoo report done "README updated" --task docs-readme --agent ufoo-builder
ufoo report list
```

决策只用于计划级约束；长期项目事实应写入 memory。

### Group

```bash
ufoo group templates
ufoo group template show build-lane
ufoo group template validate templates/groups/build-lane.json
ufoo group run build-lane --dry-run
ufoo group run build-lane --instance docs-refresh
ufoo group status
ufoo group diagram build-lane --mermaid
ufoo group stop docs-refresh
```

当前内置模板包括 `build-lane`、`build-ultra`、`design-system`、`product-discovery`、`ui-plan-review`、`ui-polish` 和 `verify-ship`。

### Online Relay

```bash
ufoo online server --host 127.0.0.1 --port 8787
ufoo online token codex:abc123 --nickname builder
ufoo online channel list --nickname builder
ufoo online room create --nickname builder --name review-room --type private --password secret
ufoo online connect --nickname builder --room review-room --room-password secret
ufoo online send --nickname builder --room review-room --text "handoff ready"
ufoo online inbox builder --unread
```

默认公开服务地址是 `https://online.ufoo.dev`；本地开发可用 `ufoo online server` 启动自己的 relay。

### 原生 ucode 运行时

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build

ucode-core submit --tool read --args-json '{"path":"README.md"}' --json
ucode-core run-once --json
ucode-core list --json
```

## 命令参考

| 范围 | 命令 |
|------|------|
| 运行态 | `ufoo`, `ufoo chat`, `ufoo -g`, `ufoo init`, `ufoo status`, `ufoo doctor`, `ufoo daemon --start|--status|--stop` |
| 项目 | `ufoo project list`, `ufoo project current`, `ufoo project switch`（v1 中仅 chat 可切换）, chat `/open <path>` |
| Agent | `ufoo launch`, `ufoo solo list|run`, `ufoo role`, `ufoo resume <target>`, `ufoo recover list|run` |
| Bus | `ufoo bus join|status|send|check|listen|alert|wake|activate` |
| Context | `ufoo ctx doctor`, `ufoo ctx decisions`, `ufoo ctx sync` |
| Memory | `ufoo memory add|list|show|edit|forget|rebuild-index|audit` |
| Report | `ufoo report start|progress|done|error|list` |
| Group | `ufoo group templates|template|run|status|diagram|stop` |
| Online | `ufoo online server|token|room|channel|connect|send|inbox` |
| History | `ufoo history build|show|prompt` |
| Skills | `ufoo skills list|install` |
| Chat 设置 | `/settings`, `/settings agent`, `/settings router`, `/settings ucode` |

## 配置

项目配置文件是 `.ufoo/config.json`。`ucode` provider 凭据写入全局 `~/.ufoo/config.json`，加载项目配置时会合并进来。

常见项目配置：

```json
{
  "launchMode": "auto",
  "agentProvider": "codex-cli",
  "controllerMode": "main",
  "codexInternalThreadMode": "api",
  "codexAuthPath": "",
  "codexOauthRefreshWindowSec": 300,
  "claudeOauthProfile": "",
  "claudeOauthTokenPath": "",
  "claudeOauthRefreshWindowSec": 300,
  "routerProvider": "",
  "routerModel": "",
  "agentModel": "",
  "autoResume": true
}
```

`launchMode` 支持 `auto`、`internal`、`internal-pty`、`tmux`、`terminal`、`host`。`controllerMode` 支持 `main`、`shadow`、`loop` 和 legacy 兼容值。

全局 `ucode` 配置：

```json
{
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-4.1",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-...",
  "ucodeAgentDir": ""
}
```

## 项目结构

仓库结构：

```text
ufoo/
  bin/                 CLI 入口
  src/                 CommonJS 实现
    agent/             Agent 启动、bootstrap、运行时、provider
    bus/               项目事件总线
    chat/              终端 dashboard UI
    cli/               命令适配层
    code/              原生 ucode core
    controller/        gate router、launch routing、shadow guard
    context/           决策与上下文检查
    daemon/            项目 daemon、IPC、编排
    group/             prompt profiles 与 group templates
    memory/            shared memory store
    online/            relay client/server helpers
    projects/          全局项目注册表
    providerapi/       redaction 与 provider shadow-diff helpers
    report/            Agent report store
    terminal/          Terminal.app、iTerm2、tmux、host adapters
    tools/             controller/tool handler registry
  templates/groups/    内置多 Agent group 模板
  modules/             init 模板和打包模块文档
  SKILLS/              打包的 Agent skills
  test/                Jest 单元测试和集成测试
```

`ufoo init` 后的项目运行态：

```text
your-project/
  .ufoo/
    agent/             Agent 元数据和运行文件
    bus/               queues、events、offsets、locks
    context/           decision 文件和索引
    daemon/            bus daemon pid/log/counts
    groups/            group runtime instances
    history/           Agent 输入时间线
    memory/            长期项目事实
    run/               project daemon pid、log、ufoo.sock
    docs -> docs/      当项目存在 docs/ 时创建的 symlink
  AGENTS.md            规范 Agent 指令文件
  CLAUDE.md            Claude 兼容指令文件
```

全局运行态位于 `~/.ufoo/`，包括 `~/.ufoo/config.json` 的 `ucode` provider 设置，以及 `~/.ufoo/projects/runtime/*.json` 的全局 chat 项目注册记录。

## 开发

```bash
npm install
npm link
node bin/ufoo.js --help
npm test
```

常用检查：

```bash
npm run test:watch
npm run test:coverage
npm run bench:global-switch
node bin/ucode-core.js --help
```

测试框架是 Jest，`testEnvironment` 为 `node`。覆盖率忽略 `node_modules` 和 `src/code/tui.js`。

## 发布

`package.json` 没有专用 release script。请在干净工作区按标准 npm 流程发布：

```bash
npm test
npm pack --dry-run
npm version patch    # 或 minor/major
npm publish
git push --follow-tags
```

发布前用 `npm pack --dry-run` 检查最终 tarball。

## 故障排查

如果 `ufoo` 不在 `PATH`：

```bash
node bin/ufoo.js --help
```

如果 Codex 默认 home 不可写：

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo
```

Codex 场景下建议使用 bus alert/listen，而不是依赖终端文本注入提醒：

```bash
ufoo bus alert codex:abc123 --daemon
ufoo bus listen codex:abc123
```

## 许可证

UNLICENSED。详见 [LICENSE](LICENSE)。
