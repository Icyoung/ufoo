# ufoo

[English](README.md)

ufoo 是一个按项目隔离的多 Agent 工作区运行时。它把 Claude Code、
OpenAI Codex、Antigravity 和 ufoo 原生 `ucode` Agent 接入同一个 chat
仪表盘、daemon、事件总线、memory、report、group 编排和终端启动层。

npm 包：[u-foo](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## 亮点

- 一个 TUI 仪表盘，用来启动、观察、消息通知和恢复多个 Agent。
- 项目 daemon 通过 `.ufoo/run/ufoo.sock` 管理启动/恢复、report、group、
  cron 和 controller 路由。
- 项目内事件总线支持 Agent 间消息、唤醒、队列检查和终端激活。
- 共享上下文能力：decision、durable memory、prompt history、report 和
  agent registry state。
- 支持 internal、tmux、host、Terminal.app、iTerm2 等启动模式。
- 内置 group 模板，用于启动和编排多 Agent 工作流。
- 提供原生 ufoo coding-agent 运行时 `ucode`。

## 环境要求

- Node.js 18 或更新版本。
- macOS，用于 Terminal.app/iTerm2 集成。
- 使用对应包装器时，需要安装 Claude Code、Codex CLI 或 Antigravity CLI：
  `uclaude`、`ucodex`、`uagy`。

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

安装后提供这些命令：

| 命令 | 用途 |
|---|---|
| `ufoo` | 主 CLI、chat 仪表盘、daemon、group、bus、context、memory、report 和 online helper。 |
| `uclaude` | Claude Code 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `ucodex` | Codex 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `uagy` | Antigravity 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `ucode` | 原生 ufoo coding-agent CLI/TUI。 |

## 快速开始

初始化项目并打开 chat 仪表盘：

```bash
cd your-project
ufoo init --modules context,bus
ufoo
```

在 chat 中启动 Agent：

```text
> /launch codex reviewer
> /launch claude builder
> /launch ucode fixer
> @reviewer inspect the current diff and list release risks
```

也可以在项目目录中直接启动包装器：

```bash
uclaude
ucodex
uagy
ucode
```

跨项目全局 chat 模式：

```bash
ufoo -g
```

## 运行模型

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/ink
  -> project daemon over .ufoo/run/ufoo.sock
  -> runtime daemon launch/resume/recover/reports/cron/groups
  -> orchestration router, group templates, solo roles
  -> agents launch/providers/internal/controller/activity
  -> coordination bus/context/memory/history/report/state/status
  -> shared controller/worker tools and native ucode tools
```

Chat 是 UI client。daemon 拥有项目运行态。Agent 通过 bus queue、prompt
injection、shared memory、report 和 tool handler 协作，而不是直接依赖
chat UI 代码。

## 日常使用

日常路径通常是先进入 chat，再在仪表盘里启动 Agent 和执行项目命令：

```bash
ufoo
ufoo -g
```

`ufoo` 打开当前项目 chat。`ufoo -g` 打开全局 chat，用于在已注册项目之间
切换。项目 daemon 会按需启动。

### Chat 内命令

```text
/launch codex reviewer
/launch claude builder
/launch ucode fixer
@reviewer inspect the current diff and list release risks

/status
/settings
/multi
/resume list
/project list
/project switch 2
/open /path/to/project
```

`uclaude`、`ucodex`、`uagy`、`ucode` 这些直接包装器仍然可用，但 ufoo 的
主要工作流是在 chat 里完成。

### 初始化与维护

这些是初始化或排障命令。进入 chat 后优先使用 slash command：

```text
/init context bus resources
/doctor
/status
/daemon status
/daemon restart
/daemon stop
/daemon start
```

`ufoo init` 会创建 `.ufoo/`，确保 `AGENTS.md` 和 `CLAUDE.md` 存在，
初始化选中的模块，并准备共享存储。`CLAUDE.md` 可以是 symlink；项目指令
优先编辑 `AGENTS.md`。

项目尚未初始化时，也可以先在外部执行等价 CLI：`ufoo init --modules context,bus`。

### 事件总线

```text
/bus list
/bus status
/bus send codex:abc123 Please implement the approved slice.
/bus activate reviewer
/bus rename codex:abc123 reviewer
```

发送消息前，先用 `/bus status` 查看真实 subscriber ID 或可解析昵称。
Agent 应处理 pending work、回复发送方，并 ack 自己的队列。

### Context、Memory、History、Report

在 chat 内：

```text
/ctx status
/ctx doctor
/ctx decisions
```

Memory、history、report 管理仍是 CLI 辅助能力：

```bash
ufoo memory add "Provider contract" --body "Durable fact..." --tags provider,contract
ufoo memory list --tag provider
ufoo memory show mem-0001

ufoo history build
ufoo history show 20
ufoo history prompt 30

ufoo report start "Implement README refresh" --task docs-readme --agent builder
ufoo report done "README updated" --task docs-readme --agent builder
ufoo report list
```

Decision 只用于计划级约束；长期项目事实应写入 memory。

### Group

内置 group 模板位于 `templates/groups/`。

```text
/group templates
/group template show build-lane
/group template validate templates/groups/build-lane.json
/group run build-lane dry_run=true
/group run build-lane instance=docs-refresh
/group status
/group diagram build-lane mermaid
/group stop docs-refresh
```

### Online Relay

```bash
ufoo online server --host 127.0.0.1 --port 8787
ufoo online token codex:abc123 --nickname builder
ufoo online room create --nickname builder --name review-room --type private --password secret
ufoo online connect --nickname builder --room <room_id> --room-password secret
ufoo online send --nickname builder --room <room_id> --text "handoff ready"
ufoo online inbox builder --unread
```

默认公开服务地址是 `https://online.ufoo.dev`。本地开发可以用
`ufoo online server` 启动自己的 relay。

### 原生 ucode 运行时

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build
```

`ucode` 可以发现内置和本地 `SKILL.md` 工作流能力。完整 skill 内容只会在被
显式引用时加载。

## 配置

项目配置文件是 `.ufoo/config.json`。`ucode` provider 凭据写入全局
`~/.ufoo/config.json`，加载项目配置时会合并进来。

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

`launchMode` 支持 `auto`、`internal`、`tmux`、`terminal`、`host`。
`controllerMode` 支持 `main`、`shadow`、`loop` 和 legacy 兼容值。

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

## 源码结构

```text
src/
  app/            chat client state 和 CLI command entry
  ui/             Ink components 和纯格式化 helper
  runtime/        daemon、projects、terminal adapters、contracts、privacy、process helpers
  coordination/   bus、context、memory、history、reports、state、status
  orchestration/  router/controller logic、groups、solo roles
  agents/         launchers、providers、prompts、internal runner、activity、controller
  code/           原生 ucode runtime、launcher、skills、file/shell tools
  tools/          shared controller/worker tool registry 和 handlers
  online/         relay client/server/runner/token helpers
```

维护者视角的项目地图见 [PROJECT.md](PROJECT.md)，更细的目录 ownership 见
[docs/source-structure.md](docs/source-structure.md)。

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
```

本仓库是 CommonJS，目标 Node.js 18+，没有 build step。

## 发布

请在干净工作区按标准 npm 流程发布：

```bash
npm test
npm pack --dry-run
npm version patch
npm publish --access public
git push --follow-tags
```

发布前用 `npm pack --dry-run` 检查最终 tarball。发布需要有 `u-foo` 权限的
npm 账号/token。

## 故障排查

如果 linked binary 不在 `PATH`，可以直接运行本地入口：

```bash
node bin/ufoo.js --help
```

如果 Codex 默认 home 不可写，可以在启动 chat 或 Agent 前指定项目内目录：

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo
```

Codex 场景下建议使用 bus helper，而不是依赖原始终端文本注入提醒：

```bash
ufoo bus alert codex:abc123 --daemon
ufoo bus listen codex:abc123
```

## 许可证

UNLICENSED。详见 [LICENSE](LICENSE)。
