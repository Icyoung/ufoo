# ufoo

[English](README.md)

ufoo 是一个按项目隔离的多 Agent 工作区运行时，提供两种用法。
你可以继续使用 Claude Code、OpenAI Codex 等原有 CLI，通过包装器和 MCP
互联、收发消息并共享上下文；也可以打开 ufoo 面板，在当前终端与主 agent
和 internal Codex、Claude、`ucode` 子 agent 协作。
两种用法共享 daemon、事件总线、memory、report 和 group 编排。

npm 包：[u-foo](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## 亮点

- 一个 TUI 面板，承载主 agent 和 internal 子 agent，提供共享输入框、
  实时输出、状态和三种布局。
- 唯一的用户级 daemon 通过 `~/.ufoo/run/ufoo.sock` 托管隔离的项目
  runtime，管理启动/恢复、report、group、cron 和 controller 路由。
- 项目内事件总线支持 Agent 间消息、唤醒、队列检查和终端激活。
- 共享上下文能力：decision、durable memory、prompt history、report 和
  agent registry state。
- 包装器和 MCP 连接外部 CLI 工作流；面板子 agent 使用 internal 模式，
  在当前终端内交互。
- 内置 group 模板，用于启动和编排多 Agent 工作流。
- 提供原生 ufoo coding-agent 运行时 `ucode`。
- home 级 global controller daemon 内提供唯一的本机 Streamable HTTP MCP
  server；`ufoo mcp` 仅作为可随时销毁的 stdio 兼容代理。

## 环境要求

- Node.js 18.17 或更新版本。
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
npm run pack:tui
npm link
```

安装后提供这些命令：

| 命令 | 用途 |
|---|---|
| `ufoo` | 主 CLI、chat 仪表盘、daemon、global MCP server/proxy、group、bus、context、memory、report 和 online helper。 |
| `uclaude` | Claude Code 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `ucodex` | Codex 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `uagy` | Antigravity 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `ukimi` | Kimi Code 包装器，注入 ufoo bootstrap 和 bus 身份。 |
| `ucode` | 原生 ufoo coding-agent CLI/TUI。 |

交互式 `ucodex` 和 `uclaude` 在 macOS/Linux 默认使用原生消息通道。
Codex 的 TUI 连接本次启动的私有 app-server，Claude 使用本次启动的 MCP
channel；不会修改宿主全局配置或认证信息。Claude 保留原有开发通道确认，
账号及组织策略限制仍然适用。接收器确认就绪后才投递消息。

启动器检查已验证的版本基线（Codex 0.160.1、Claude Code 2.1.204）及
Codex remote 支持；旧版本会提示并使用原有投递方式。
`--native-messages` 强制要求兼容，`--no-native-messages` 或
`UFOO_NATIVE_MESSAGES=0` 关闭原生通道。`ufoo doctor` 展示版本和接收器状态。

投递回执仅表示通道接收，不表示任务完成。响应丢失会保留消息和不确定
回执，不自动重发。可使用以下命令检查并明确处理：

```bash
ufoo bus deliveries <subscriber>
ufoo bus deliveries <subscriber> <receipt-id> accepted
ufoo bus deliveries <subscriber> <receipt-id> retry
```

确认接收会话已收到任务后用 `accepted`；`retry` 允许再投递一次，如果
第一次实际成功可能产生重复。正在投递且所属进程存活的回执不能解锁。

任务报告的各个阶段应复用同一个 `--task <id>` / MCP `task_id`。省略 ID
时，CLI 的 progress/done/error 只关联唯一活跃任务；并行任务必须显式指定。
报告持久化成功后才确认消费，普通 bus 回复不会把任务标为完成。
`autoResume` 默认关闭，局部保存配置不会改变其默认值。

## 快速开始

初始化项目并打开 chat 仪表盘：

```bash
cd your-project
ufoo init --targets context,bus
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
ukimi
ucode
```

跨项目全局 chat 模式：

```bash
ufoo -g
```

Codex App、Codex CLI 和 Codex IDE extension 共用同一份配置。先启动一次
global mode，再写入经过验证的直接 HTTP 配置：

```bash
ufoo -g
ufoo mcp configure codex
```

重启 Codex surface 后即可使用。尚未验证直接 HTTP 的 host 继续配置
`ufoo mcp`；该命令只是连接同一 global server 的无状态 stdio 代理，不拥有
Agent 注册或项目状态。用 `ufoo mcp status` 检查唯一 listener，用
`ufoo mcp restart` 只重启 listener。

## 运行模型

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/rustChatHost + crates/ufoo-tui
  -> global daemon over ~/.ufoo/run/ufoo.sock
  -> isolated ProjectRuntime selected by project_root
  -> runtime launch/resume/recover/reports/cron/groups
  -> orchestration router, group templates, solo roles
  -> agents launch/providers/internal/controller/activity
  -> coordination bus/context/memory/history/report/state/status
  -> shared controller/worker tools and native ucode tools

Codex App / CLI / IDE -> Streamable HTTP --+
ufoo mcp stdio proxy ----------------------+
                                           -> home-scoped global controller daemon
  -> one MCP listener and tool router
  -> ~/.ufoo/projects/runtime
  -> managed ProjectRuntimeGateway
  -> selected in-process ProjectRuntime for bus/report/activity/wait state
```

默认使用 global topology。`ufoo daemon --topology hybrid` 可临时启用项目
兼容 socket，`--topology project` 则切回旧的逐项目 daemon 回滚路径。

### Agent 消息投递模式

ufoo 支持两种 Agent 投递模式，只根据启动辅助 terminal 之前，宿主 Agent
继承的 `UFOO_SUBSCRIBER_ID` 是否存在来选择：

- 包装器托管的 Agent 通过 `ucodex`、`uclaude`、`uagy`、`ukimi` 或 `ucode`
  启动。包装器会提供 `UFOO_SUBSCRIBER_ID`；ufoo 能监控其 shell 活动并定位
  注入端点，因此可以直接注入 bus 消息。这类 Agent 复用环境中的身份，
  不通过 MCP 重复注册，也不运行常驻 bus poll。
- 外部 host 托管的 Agent 没有包装器提供的 subscriber 环境变量。它通过 MCP
  `register_agent` 注册一次，保留返回的 subscriber 和不透明
  `agent_handle`，再选择宿主 App 原生的无 token 等待方式：Codex App 挂起
  MCP `wait_for_message`，Cursor 则用 `notify_on_output` 监控
  `ufoo bus poll --follow` 的后台输出。

Agent 类型名和 subscriber 前缀只是路由元数据，不是能力判断条件。外部
Cursor Agent 通过 MCP 注册后，可以在专用监听 terminal 内把返回的
subscriber 导出为 `UFOO_SUBSCRIBER_ID`，让 CLI 操作复用同一身份。这个
子 shell 绑定不会改变宿主 Agent 已选择的外部模式，也不代表支持包装器注入。

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
切换。全局 daemon 只启动一次，各项目 runtime 按需激活。

默认项目主 Agent 与 `ucode` 共用可组合的 runtime，可直接读取、修改代码并执行验证，
也可委派外部 Agent 或创建独立任务。全局入口只负责选择项目；进入项目后才获得
编码能力。长任务在后台运行，断开 chat 不会取消任务，重连会补发运行事件。

旧 controller 会话保留原执行路径。用 `/session new` 开始新主会话；旧会话的
provider/model 绑定不会随设置变更而切换。副作用执行期间进程崩溃后，任务会标为
interrupted，需检查实际结果后决定是否重新提交；不会自动重复文件修改、shell、
启动或投递。相同目录的托管写操作共用锁，独立且经过验证的 git worktree 可并行。
这些约束不构成 shell 的操作系统沙箱。实现与恢复契约见
[Agent Runtime 改造记录](AGENT_RUNTIME_REFACTOR.md)。

### Chat 内命令

```text
/launch codex reviewer
/launch claude builder
/launch ucode fixer
@reviewer inspect the current diff and list release risks

/status
/task list
/task inspect <run-id>
/task cancel <run-id>
/answer <interaction-id> <reply>
/session show
/session new
/settings
/multi
/multi on
/multi off
/multi @reviewer
/resume list
/project list
/project switch 2
/open /path/to/project
```

面板保留三种布局：仅主 agent、主 agent 加一个选中的 internal 子 agent、
主 agent 加全部 internal 子 agent。包装器与 MCP agent 不进入面板；面板
启动的子 agent 只使用 internal 模式，不会打开外部终端。当前文件夹没有
聊天或输入历史时，欢迎页复用已有的紧凑 ufoo banner。
`/multi` 或 `Ctrl+T` 切换全部子 agent 布局，在单子 agent 布局中使用会展开全部。
`Ctrl+M` 打开全部子 agent 布局，再按一次仍保持打开。面板会自动请求增强键盘
协议，需要终端能区分 Ctrl+M 与回车；传统终端中两者编码相同，回车仍用于提交，
可继续使用 `/multi` 或 `Ctrl+T`。
`/multi @reviewer` 只打开指定 internal 子 agent。两种分屏布局中，子 agent
获得焦点时按 `Esc` 先回到主 agent 输入栏，再按一次退出分屏；焦点已在
主 agent 时，按 `Esc` 直接退出分屏。草稿和运行中的任务都会保留。
`Ctrl+Q` 或 `/multi off` 仍可直接退出分屏。
回到仅主 agent 后，再按 `Esc` 不会退出应用；退出请使用 `Ctrl+C`。
`Tab` 在主 agent 和当前显示的子 agent 窗格之间循环切换输入焦点；单子 agent
布局在这两个 agent 之间切换。所有 agent 共用底部一个输入框，随当前选中的 agent
切换，每个 agent 的草稿独立保留。各 agent 的实时状态嵌在各自窗格底边，选中窗格
的正文使用终端默认前景色。
主 agent 的输入框标题使用 `main`；选择子 agent、切换焦点及子 agent 的工作状态
不会覆盖主 agent 自己的状态。
仅主 agent 时，`Tab` 先选中底部第一个 agent，之后依次选择下一个，末尾回到第一个；
`Esc` 返回主输入栏。仅主 agent 布局
下，命令补全仍沿用 `Tab`。布局命令在选中 internal 子 agent 的共享输入框中
也可以使用；切换布局会保留未发送的子 agent 输入，不会停止运行中的任务。
子 agent 激活时，在空输入框按 `↓` 或点击底栏可进入 Agents 选择；再按 `↓`
进入 provider 设置和 cron 控制。`Esc` 返回原 agent 的输入框，选择 agent 后按
`Enter` 打开它。也可以直接点击底栏的 provider 名称进入设置。

`uclaude`、`ucodex`、`uagy`、`ukimi`、`ucode` 这些直接包装器仍然可用，但 ufoo 的
主要工作流是在 chat 里完成。

### 初始化与维护

这些是初始化或排障命令。进入 chat 后优先使用 slash command：

```text
/init context bus
/doctor
/status
/daemon status
/daemon restart
/daemon stop
/daemon start
```

`ufoo init` 会创建 `.ufoo/`，确保 `AGENTS.md` 和 `CLAUDE.md` 存在，
初始化选中的工作区状态，并准备共享存储。`CLAUDE.md` 可以是 symlink；
项目指令优先编辑 `AGENTS.md`。

项目尚未初始化时，也可以先在外部执行等价 CLI：`ufoo init --targets context,bus`。

默认 Agent skill 有意精简为 `ufoo`、`ufoo-bus`、`ufoo-context` 和
`ufoo-online`。它们只作为 skill 安装，不再生成一份 command 目录，
避免宿主显示两个入口；初始化和统一状态统一由 `ufoo` 处理。

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

没有 `UFOO_SUBSCRIBER_ID` 的外部 Agent 使用可选的 `ufoo-bus-poll` skill，
由它选择宿主 App 对应的队列只读等待和自身唤醒方式：

```bash
ufoo skills list --optional
ufoo skills install ufoo-bus-poll --target /path/to/that/agent/skills
```

先通过 MCP `register_agent` 注册一次并保留返回的 subscriber 与
`agent_handle`。heartbeat、activity、send、receive、ack、report 和
unregister 都带上该 handle；它是所有权凭证，不应发送给其他 Agent，也不应
写进 report。

- **Codex App：**前台调用 MCP `wait_for_message`，传入注册所得 subscriber
  和 handle，首次使用 `after_seq: 0`、`timeout_seconds: 0`。工具调用在
  独立的 `ufoo_wait` MCP 连接中持续等待消息或调用方取消，空闲时不会周期性
  唤醒模型；有消息立即返回并唤醒当前任务，不依赖 shell stdout。
  处理消息后，用同一 handle，并以返回的 `last_seq` 作为 `through_seq`
  调用 MCP `ack_bus`，Agent 再次空闲时以该 `last_seq` 续挂。
- **Cursor：**在 monitored background shell 中绑定 MCP subscriber，再运行
  `export UFOO_SUBSCRIBER_ID="<subscriber-id>"; exec ufoo bus poll
  "$UFOO_SUBSCRIBER_ID" --follow --interval 30`，设置
  `block_until_ms: 0`，并让 `notify_on_output` 匹配 `\[ufoo\]`。启动和
  空轮询保持静默，只有 ufoo 投递消息会唤醒模型。

两条路径都把空闲检查留在 LLM 之外。仅有后台 PTY 输出并不能唤醒 Codex App。

poll skill 不会由 postinstall 或 `skills install all` 首次安装。postinstall
只更新确认归 ufoo 管理的符号链接，保留用户目录、文件和外部链接；手动安装
会把原内容保存在旁边的 `.backup-*` 路径。`skills install all` 可更新已安装
的可选技能。如果
`UFOO_SUBSCRIBER_ID` 在 Agent 启动时的继承环境中已经存在，包装器托管的
Agent 就跳过 MCP 注册和外部等待；之后在 Cursor 监听 terminal 中导出的值
不会重新触发这次分类。接收链路由宿主 App 的能力决定，与外部 Agent 叫
Codex、Claude、Cursor 或其他类型无关。

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

Internal Codex、Claude Code 和 ucode 窗格复用独立 ucode TUI 的内容渲染，共用底部一个多行输入框。
提交后立即显示 loading；等待、思考、生成、工具执行、等待用户、失败、运行计时、
上下文用量和计划进度随当前 agent 的真实事件变化。provider 提供的重试、上下文压缩
和后台任务事件也接入同一状态层。
文本、思考和工具结果随 provider 事件刷新；在选中的窗格按 Ctrl+O 可展开最近的思考或工具块。
显示事件独立于 agent 收件箱，agent 之间派发的任务也能显示，且不会唤醒主 agent。
切换单主窗格、激活子窗格和全部子窗格时，保留输出与输入草稿。

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
  "autoResume": false
}
```

`launchMode` 支持 `auto`、`internal`、`tmux`、`terminal`、`host`。
`controllerMode` 支持 `main`、`shadow`、`loop` 和 legacy 兼容值。

普通 provider 会话通过各自的凭据适配器认证；MCP `agent_handle` 不用于模型请求。
只有选择 `agentProvider=ucode` 才使用下列 ucode 网关设置。

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
  ui/             Rust TUI hosts + 纯格式化 helper
  crates/ufoo-tui Rust ratatui 子进程（chat/ucode 必需）
  runtime/        daemon、projects、terminal adapters、contracts、privacy、process helpers
  coordination/   bus、context、memory、history、reports、state、status
  orchestration/  router/controller logic、groups、solo roles
  agents/         shared runtime、capabilities、profiles、providers、launchers、prompts
  code/           原生 ucode host、launcher、skills、file/shell tools
  tools/          shared controller/worker tool registry 和 handlers
  online/         relay client/server/runner/token helpers
```

维护者视角的项目地图见 [PROJECT.md](PROJECT.md)，更细的目录 ownership 见
[docs/source-structure.md](docs/source-structure.md)。

## 开发

```bash
npm install
npm run pack:tui
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

本仓库是 CommonJS，目标 Node.js 18+，并通过 `dist/tui/` 附带 Rust TTY UI
（`crates/ufoo-tui`）的平台二进制。

## 发布

发布由 GitHub Actions（`.github/workflows/release.yml`）完成：多平台编译
`ufoo-tui`（`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64`），
写入 `dist/tui/<platform>/`，再执行 `npm publish`。

1. 升版本并推送对应 tag：

```bash
npm test
npm version patch   # 提交 package.json 并创建 tag vX.Y.Z
git push --follow-tags
```

2. 仓库需配置 secret `NPM_TOKEN`（对 `u-foo` 有发布权限的 npm automation token）。
3. 推送 `v*` tag 后自动跑 `Release` workflow。也可在 Actions 里手动
   **Run workflow**（`dry_run=true` 只打包不发布）。

本地单平台预演：

```bash
npm run pack:tui
npm pack --dry-run
```


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
