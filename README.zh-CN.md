# ufoo

[English](README.md) · [项目架构指南](docs/PROJECT.md) · [可观测性与指标](docs/OBSERVABILITY.md) · [文档目录](docs/README.md)

**多 Agent 工作区运行时协议（Multi-Agent Workspace Runtime）。** 只需在原有命令前加个 `u` —— `claude` → `uclaude`、`codex` → `ucodex`、`agy` → `uagy`、`grok` → `ugrok`、`kimi` → `ukimi`；或直接打开 `ufoo`，在同一个 Rust TUI 终端面板里让项目主 Agent 与内嵌的 Codex、Claude、原生 `ucode` 子 Agent 并行协作。

npm 包：[u-foo](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue.svg)](https://github.com/Icyoung/ufoo)

---

## 核心特性

ufoo 为代码仓库内的所有 AI Agent 提供统一控制面与状态底座，同时保留你熟悉的任何工具链：

- **一体化 Rust TUI 协作面板（`ufoo` & `ucode`）**：单终端承载主 Agent 与多个 internal Codex、Claude、`ucode` 子 Agent，支持 `main` / `side` / `multi` 三种分屏布局、按 Agent 独立保留输入草稿、实时展开思考与合并工具树（`Ctrl+O`）、窗格内鼠标拖选即复制，以及 `/resume` 一键恢复单 Agent 或整个 Group。
- **可组合原生 Agent Runtime 与 Context Engine V2**：主 Agent、独立后台子任务（`manage_tasks`）与 `ucode` 共用同一套可插拔内核，内置 KV-Cache 友好的滑动窗口、自动 `<turn_context>` 主题索引、跨窗口按需检索工具 `recall_turn`、结构化 `plan_graph` / Plan Mode、崩溃安全日志、工作区写租约以及**后台命令零 Token 自动唤醒**。
- **日常 Chrome 浏览器自动化（`browser`）**：通过可选的 `ufoo Browser` 扩展与本机 `BrowserBroker` 直接操控你平时已登录的 Chrome，支持按 `tabId` 独立声明标签页所有权（冲突时返回 `browser_tab_busy`），绝不强开空白浏览器或关闭已有页面。
- **macOS 桌面应用控制与独立 Agent 鼠标（`mac_app`）**：融合 `AXUIElement` 无障碍控件树快照（`@e1..@eN` 引用 + 原生动作触发）、无阴影 1:1 逻辑点截图（`screenshotId` 精准坐标映射）与**独立窗口级 Agent 鼠标**——无需抢占或移动你的物理鼠标即可附带悬浮 HUD 操作应用，并在检测到晃动鼠标、点击目标窗口或按下 `Esc` 时立即避让。
- **无侵入包装器与全局单例 MCP**：支持 `uclaude`、`ucodex`、`uagy`、`ugrok`、`ukimi` 原生消息注入，同时通过 `~/.ufoo/run/ufoo.sock` 全局守护进程内置的 Streamable HTTP MCP Server 与无状态 `ufoo mcp` stdio 代理连接 **Codex App/IDE**、**Cursor**、**Antigravity App** 及 HTTP Webhook。
- **多 Agent Group 编排、共享记忆与可观测性**：内置 7 套专业多角色协作模板（预置 `codex` / `claude` / `agy` 分角色模型与推理强度）、架构决策（`ctx`）与持久化共享记忆（`memory`）、证据门控任务验收、`ufoo online` 远程协作中继，以及免模型调用的 `ufoo trace` 与 `ufoo metrics` 性能审计。

---

## 环境要求与安装

### 环境要求

- **Node.js 18.17+**（可选的 `ufoo Browser` Playwright MCP 运行时需要 **Node.js 20+**）。
- **macOS** 或 **Linux**（npm 包已内置 `darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64` 的 `ufoo-tui` 原生二进制；`mac_app` 桌面控制与 Terminal.app/iTerm2 终端适配仅限 macOS）。
- 使用对应 CLI 包装器时需预先安装相应宿主 CLI（`claude`、`codex`、`agy`、`grok`、`kimi`）。

### 从 npm 安装

```bash
npm install -g u-foo
ufoo setup
```

`ufoo setup` 会询问是否安装可选组件 **ufoo Browser**（也可显式指定 `ufoo setup --browser=install` 或 `ufoo setup --browser=skip`；非交互环境下默认跳过可选下载）。

### 从源码构建

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm run pack:tui
npm link
```

### 提供的命令入口

| 命令 | 职责说明 |
|---|---|
| `ufoo` | 主 CLI、多 Agent 仪表盘、全局/项目 daemon、MCP 服务与 stdio 代理、`browser` / `mac` 管理、group、bus、context、memory、report、trace/metrics 与 online 中继。 |
| `ucode` | 原生 ufoo 编程 Agent CLI/TUI，共享可组合 runtime、Context Engine V2、`browser` 与 `mac_app` 能力。 |
| `uclaude` | Claude Code 包装器，自动注入 bootstrap、bus 身份、原生 stdio MCP 消息通道与会话恢复元数据。 |
| `ucodex` | OpenAI Codex 包装器，自动注入 bootstrap、bus 身份、私有 app-server 原生入站队列与会话恢复支持。 |
| `uagy` | Antigravity CLI 包装器，注入 bootstrap、bus 身份并捕获会话恢复标识。 |
| `ugrok` | Grok Build 包装器，注入 bootstrap 并自动注册事件总线。 |
| `ukimi` | Kimi Code 包装器，注入 bootstrap、注册事件总线并保留恢复元数据。 |

---

## 快速开始

### 1. 启动项目协作面板（推荐日常工作流）

```bash
cd your-project
ufoo init --targets context,bus
ufoo          # 打开当前项目面板
ufoo -g       # 或打开全局路由视图，在多个已注册项目间随时切换
```

在面板内直接对话，或拉起内嵌子 Agent 与协作组：

```text
> /launch codex reviewer
> /launch claude builder
> /launch ucode fixer
> @reviewer 检查当前 diff 并列出上线风险
> /group run build-lane instance=auth-refactor
```

### 2. 直接在终端运行包装器 CLI

在项目目录中直接执行任一包装命令，即可自动接入项目事件总线与共享记忆：

```bash
uclaude
ucodex
uagy
ugrok
ukimi
ucode
```

### 3. 通过全局 MCP 连接外部 IDE / 桌面客户端

- **Codex App、Codex CLI 与 Codex IDE 插件**（共享本机鉴权 Streamable HTTP 端点）：
  ```bash
  ufoo -g
  ufoo mcp configure codex    # 可加 --dry-run 预览脱敏后的配置变更
  ```
  写入后重启对应的 Codex 客户端即可生效。

- **Cursor、Antigravity App 及其他 MCP 客户端**（使用无状态 `ufoo mcp` stdio 代理，自动兼容换行 JSON 与 `Content-Length` 帧）：
  ```json
  {
    "mcpServers": {
      "ufoo": {
        "command": "ufoo",
        "args": ["mcp"]
      }
    }
  }
  ```
  可通过 `ufoo mcp status` 与 `ufoo mcp restart` 查看或重启全局唯一 MCP 监听器。

---

## 面板交互与快捷键指南

`ufoo` 与独立 `ucode` 均通过 Rust 编写的 `ufoo-tui` 渲染（`ufoo-ui/1` 协议）。任务执行状态由后台 daemon 持有，关闭面板不会中断运行中的任务，重新连接会自动回放完整输出流与折叠块。

### 三种窗口布局

使用 `Ctrl+W` 循环切换 `main → side → multi → main`，或直接执行 `/window main`、`/window side`、`/window multi`：

- **`main`**：主 Agent 全宽视图。
- **`side`**：左侧主 Agent + 右侧当前激活的单个 internal 子 Agent。
- **`multi`**：主 Agent + 所有活跃 internal Codex / Claude / `ucode` 子 Agent 同屏并列。

| 快捷键 / 鼠标操作 | 说明 |
|---|---|
| `Ctrl+W`（在 `main` 输入框） | 循环切换布局；在子 Agent 输入框内则为删除前一个单词。 |
| `Ctrl+Q` | 退出分屏回到 `main` 视图（不关闭子 Agent，保留所有未发送草稿）。 |
| `Tab` | 分屏下进入可见子窗格；单窗下切换底栏 Agent；补全菜单开启时确认补全。 |
| `Esc` | 关闭当前弹层菜单，或从子 Agent 输入框切回 `main` 输入框（不中断子任务）。 |
| `Ctrl+C` | 子窗格内仅取消该子 Agent 当前轮次（保留进程与队列）；`main` 内依次清空草稿、取消任务或退出。 |
| `Ctrl+O` | 展开或收起当前焦点窗格中最新的一组思考过程或工具调用树。 |
| `Ctrl+X`（焦点位于底栏 Agents 时） | 通过项目 daemon 安全关闭选中的 internal 子 Agent。 |
| 窗格内鼠标拖选并松开 | 仅选中当前窗格内的文本（不含边框与相邻窗格），松开即通过系统剪贴板或 OSC 52 自动复制。 |

### 常用面板 Slash 命令

```text
/status                         查看项目、daemon 与在线 Agent 状态概览
/launch <codex|claude|ucode>    在面板内启动内嵌子 Agent
/resume                         恢复已保存的独立子 Agent 或整组 Group（group:<id>）
/task list | inspect | cancel   管理独立上下文的后台编码任务
/answer <interaction-id> <text> 回复处于 ask_user 等待状态的任务提问
/session show | new             查看当前会话或基于最新设置开启新主会话
/settings                       配置主 Agent 或 ucode 的 provider、自定义网关、模型与思考强度
/group templates | run | status 启动、预览与管理多 Agent Group 协作流
/ctx status | decisions | doctor 查看架构决策与上下文健康状态
/bus status | list | send       检查事件总线队列并向任意在线 Agent 发送消息
/project list | switch <n>      查看或切换已注册项目
/open /path/to/project          直接挂载并切换到指定目录项目
/doctor                         自检 CLI 版本基线、MCP 配置与待决投递回执
```

---

## 原生 Agent Runtime 与 `ucode`

项目主 Agent、可写独立子任务（`manage_tasks`）与 `ucode` 共用分层可组合的原生运行时（`src/agents/runtime/`）。

### Context Engine V2 与 `recall_turn`

- **KV-Cache 稳定的滑动窗口**：默认保留 `Step=2` 对齐的近 5 轮完整原始对话（热点话题可在 45% 历史预算内弹性扩展至 10 轮），最大化命中大模型前缀缓存。
- **瞬态 `<turn_context>` 注入**：仅在当前轮次用户消息上挂载轻量 `<topic_map>` 与 `<relevant_turns>` 摘要，落盘与归档前自动剥离，不污染历史记录。
- **可选后台异步富化（Aux Model）**：配置 `agentAuxModel` 或 `ucodeAuxModel` 后，后台异步精炼历史轮次摘要与二阶段语义召回；未配置时产生零额外模型请求。
- **确定性溢出淘汰与 `recall_turn`**：超长上下文采用 Level 1–3 确定性分级裁剪，无需阻塞式摘要请求；模型可随时调用 `recall_turn` 搜索窗口外历史或分页精读原始对话。

### Plan Mode、执行预算与目录写租约

- **Plan Mode 与 `plan_graph`**：输入 `/plan on`（或模型调用 `plan_graph create` 后自动开启），拦截直接副作用工具（`write`、`edit`、`bash` 及状态修改类 `browser` / `mac_app` 操作），仅放行只读探测并按 `plan_graph` 节点有序推进；用户执行 `/plan off` 即可退出。
- **执行与死循环防护**：默认不限制工具调用总次数，单任务超时上限 12 小时（支持 `ucode --max-tool-calls <N|none>`、`UFOO_UCODE_MAX_TOOL_CALLS`、`UFOO_UCODE_MAX_TOOL_ERRORS`、`UFOO_UCODE_TASK_TIMEOUT_MS` 覆盖）。连续工具报错满 3 次告警、5 次熔断（滑动 20 次满 12 次熔断）；连续重复相同工具批次会自动提醒并阻断死循环。
- **崩溃安全与并发写锁**：每轮完整模型/工具批次落盘后再发起下一轮请求；异常中断的未知副作用绝不自动重放。同目录写操作共享互斥租约，独立已验证的 `git worktree` 可完全并行写入。

### 后台命令零轮询自动唤醒

启动开发服务器、构建或监听任务时可声明一次性唤醒条件，等待期间不消耗任何模型轮询 Token：

```json
{
  "command": "npm run dev",
  "background": true,
  "wake": {
    "conditions": [{ "type": "log_contains", "text": "Ready in" }]
  }
}
```

支持 `log_contains`、`file_exists`、`port_open`（`127.0.0.1`）以及进程退出通知（默认开启，`wake.onExit: false` 可关闭）。订阅持久化到磁盘并在安全轮次边界自动续跑会话。

### Agent 技能安装与同步

`npm install` 时会自动维护 `ufoo`、`ufoo-bus`、`ufoo-context`、`ufoo-online` 四个核心技能符号链接，且绝不覆盖用户自建文件。支持按宿主显式安装：

```bash
ufoo skills list --optional
ufoo skills install all --claude          # ~/.claude/skills
ufoo skills install all --codex           # ${CODEX_HOME:-~/.codex}/skills
ufoo skills install all --agy             # ~/.gemini/config/skills
ufoo skills install all --agents          # ~/.agents/skills
ufoo skills install ufoo-bus-poll --target /path/to/skills
```

---

## 浏览器与 macOS 桌面应用自动化

项目主 Agent、可写独立子任务与 `ucode` 均内置 `browser` 和 `mac_app` 工具；截图自动通过多模态 Vision 数据块直传模型，并在完成识别后自动退化为轻量路径标记以节省上下文。

### 1. 日常 Chrome 操控（`browser` / `ufoo browser`）

直接连接你正在使用、已登录账号的日常 Chrome（需 **Node.js 20+**），不启动空白浏览器，断开连接也绝不关闭用户窗口或标签页：

```bash
ufoo setup --browser=install     # 安装可选 Playwright MCP 运行时并注册 Native Messaging Host
ufoo browser install --dev       # 商店上架前启用开发者模式并从 extensions/ufoo-browser/ 加载解压扩展
ufoo browser status [--json]
ufoo browser doctor
ufoo browser enable | disable | update | uninstall
```

- **`BrowserBroker` 标签页级隔离**：`ufoo Browser` 扩展通过 Chrome Native Messaging 自动连接用户级 Broker（`~/.ufoo/browser/private/broker.sock`）。Agent 先用 `browser_tabs`（`action=list`）查看标签页并按 `tabId` 认领；已被其他会话占用的标签页返回 `browser_tab_busy`，你也可随时在扩展弹窗中暂停控制或释放标签页。
- **兼容模式**：同时支持官方 Playwright Extension（`backend: "playwright-extension"`）以及显式 CDP 端点（`UFOO_BROWSER_CDP_ENDPOINT=chrome` 或 `http://127.0.0.1:9222`，带系统用户级独占锁）。
- **按需工具发现**：通过 `status`、`connect`、`tools`、`call`、`disconnect` 按需查询具体工具 Schema，保持基础系统提示词精简以稳定命中缓存。大文本与截图保存在 `.ufoo/browser/<session-hash>/`。

### 2. macOS 桌面应用与独立 Agent 鼠标（`mac_app` / `ufoo mac`）

在 macOS 上通过自动编译缓存的零依赖原生 Swift 守护助手（`~/.ufoo/mac/bin/`，私有 Unix Socket 通信）操控各类原生 Cocoa、SwiftUI 与 Electron 桌面应用：

- **AX 无障碍结构化操控（`AXUIElement`）**：支持 `list_apps`、`list_windows`、`snapshot`（自动唤醒 Electron/Chromium 无障碍树，生成 `@e1..@eN` 引用，支持 `includeMenuBar=true` 菜单栏探测与 `query` 关键词过滤）、`ax_action`（`press`、`focus`、`set_value`、`confirm`、`pick`、`show_menu` 等），以及 `launch_app`、`focus_app`、`manage_window`。
- **1:1 逻辑点无阴影截图**：支持按应用/窗口（`-o -l` 去阴影）、区域或显示器截图，默认自动重采样至 **1:1 macOS 逻辑点分辨率**；传入返回的 `screenshotId` 即可将图片像素 `(x, y)` 精准映射到实时窗口屏幕坐标，彻底消除 Retina `2x` 坐标偏移。产物保存在 `.ufoo/mac/<session-hash>/`。
- **独立 Agent 鼠标与人工接管避让**：
  - 每个会话维护独立的虚拟指针，通过窗口定向 `NSEvent` / `CGEvent.postToPid` 投递事件，**不会移动或抢占你的物理鼠标光标**。
  - 屏幕提供不可被截图捕获（`sharingType = .none`）的轻量悬浮 **Agent Mouse HUD**，实时指示当前虚拟光标位置、点击波纹与动作标签。
  - 默认不强行切出后台窗口（需前置激活时显式传 `focusApp=true`；后台投递兼容性因应用而异，操作后请结合 `snapshot` 或 `screenshot` 校验结果；不支持跨窗口拖拽，且不兼容场景绝不会退化为抢占物理鼠标）。
  - **即时避让**：普通移动物理鼠标互不干扰；当你刻意晃动鼠标、在目标窗口内物理点击或按下 `Esc` 时，立即触发 `user_takeover` 并让出控制权。

```bash
ufoo mac status [--json]         # 查看助手状态、显示器信息与系统权限
ufoo mac permissions             # 触发授权提示并打开 macOS「辅助功能 / 屏幕录制」设置面板
ufoo mac doctor                  # 自检 Swift 编译缓存、守护进程 Socket RPC 与权限项
ufoo mac hud on | off | toggle   # 开关屏幕上的 Agent 鼠标可视化悬浮层
ufoo mac enable | disable | stop
```

---

## 运行架构与 Agent 消息投递协议

```text
ufoo / ufoo chat / ucode
  -> src/app/chat + src/ui/ + crates/ufoo-tui (基于 ufoo-ui/1 的 ratatui 终端界面)
  -> 用户级单例 GlobalDaemon (~/.ufoo/run/ufoo.sock)
  -> 按项目隔离的 ProjectRuntime (~/.ufoo/projects/runtime)
  -> orchestration (智能路由、7 套 Group 模板、Solo 角色、Cron 调度)
  -> 共享原生 Agent Runtime + SDK 内嵌 Runner + CLI 包装器
  -> .ufoo/ 协作状态存储 (事件总线、架构决策、共享记忆、历史、报告、会话日志)

外部 MCP 客户端接入:
  Codex App / CLI / IDE  --(Streamable HTTP)--> GlobalDaemon 唯一 MCP 监听器与路由器
  Cursor / agy / 其他    --(ufoo mcp 代理)---->   -> ProjectRuntimeGateway -> 项目总线与工具集
```

### 两种确定性 Agent 投递分支

ufoo 仅根据宿主 Agent 启动时是否继承 `UFOO_SUBSCRIBER_ID` 环境变量来决定消息投递模式：

1. **包装器托管模式（`ucodex`、`uclaude`、`uagy`、`ugrok`、`ukimi`、`ucode`）**：
   - 启动时继承 `UFOO_SUBSCRIBER_ID` 与 `UFOO_AGENT_HANDLE`，由包装器与 daemon 负责注册、监控活跃度并直接注入消息。
   - **原生入站消息通道**：交互式 `ucodex`（基线版本 `0.160.1+`）挂载单次启动私有的 app-server 并通过 `thread/queue/add` 入队任务；交互式 `uclaude`（`2.1.204+`）使用单次启动专属 stdio MCP channel 并验证启动探针。两者均不篡改宿主全局配置；投递状态不确定时会保留持久化回执供人工裁决（`ufoo bus deliveries <subscriber> [<receipt-id> accepted|retry]`），绝不退化为盲目键盘敲击注入。可用 `--no-native-messages`（或 `UFOO_NATIVE_MESSAGES=0`）显式关闭。

2. **外部宿主自注册模式（未继承 `UFOO_SUBSCRIBER_ID`）**：
   - 通过 MCP `register_agent` 注册一次，获取服务端分配的 `<prefix>:<8-hex>` ID、`<prefix>-N` 昵称及不透明凭证 `agent_handle`（传入稳定的 `client_instance_id` 可在重连后恢复同一身份）。
   - 配合可选技能 `ufoo-bus-poll`，按宿主能力实现**空闲零 Token 挂起唤醒**：
     - **Codex App**：在专用的 `ufoo_wait` MCP 连接上前台挂起 `wait_for_message`，收到消息立即唤醒并通过 `ack_bus` 确认。
     - **Cursor**：在受监控后台终端运行 `ufoo bus poll "<subscriber-id>" --follow --interval 30`，配置 `notify_on_output` 匹配 `\[ufoo\]` 唤醒。
     - **Antigravity App（`agy app`）**：启动静默后台等待循环检查 `ufoo bus check "<subscriber-id>"`，仅在检测到 `[ufoo]` 新消息时打印并 `exit 0` 触发宿主自动唤醒，处理完通过 MCP `ack_bus` 确认后续挂。
   - **HTTP Webhook 唤醒**：支持通过 `ufoo bus join <session> grok-bot --wake-url https://... --wake-key-file /path/to/key` 注册远程 Webhook Agent（`bearer-json` 协议，经 `ufoo bus ack` 顺序放行）。

---

## 多 Agent Group 编排、共享记忆与可观测性

### 内置多角色 Group 模板（`templates/groups/`）

内置 `build-lane`、`build-ultra`、`design-system`、`product-discovery`、`ui-plan-review`、`ui-polish`、`verify-ship` 7 套协作流水线模板：

```text
/group templates
/group template show build-lane
/group run build-lane dry_run=true
/group run build-lane instance=release-v4
/group status
/group diagram build-lane mermaid
/group stop release-v4
```

所有内置成员均预置 `codex`、`claude`、`agy` 三套分角色最佳模型与推理强度配置，并预留 `override` 手动覆盖字段：

| 角色定位 | Codex（模型 / 思考强度） | Claude | Antigravity (`agy`) |
|---|---|---|---|
| Architect / Debugger / Discovery / Design Consultant | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-carbon-high` |
| Builder / Frontend Refiner | `gpt-6.1-sol` / `high` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |
| Reviewer / Scope Challenger / Critics / Release Coordinator | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-argon-high` |
| PMO | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-argon-high` |
| QA | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |

### 决策、持久化记忆、任务报告与证据门控验收

```bash
# 持久化长期项目事实（计划级架构约束请使用 /ctx decisions）
ufoo memory add "鉴权刷新约定" --body "OAuth 提前刷新窗口统一为 300 秒..." --tags auth,api
ufoo memory list --tag auth
ufoo memory show mem-0001

# 统一输入时间线与任务生命周期报告
ufoo history build && ufoo history show 20
ufoo report start "重构会话存储" --task store-v2 --agent builder
ufoo report done "全部单测通过" --task store-v2 --agent builder
ufoo report list
```

Worker 完成汇报保持 1–4 行精简结论并引用工作区证据文件；父 Agent 验收（`accept_task` / `manage_tasks operation=accept`）与执行完成严格解耦，必须附带汇报完成后的实测验证工具 `toolCallId` 证据。

### 执行链路追踪与指标基线（`OBSERVABILITY.md`）

无需启动 daemon 或消耗模型调用，即可离线串联父子任务的模型耗时、工具配对、上下文投影与委派验收率：

```bash
ufoo trace <task-id> --json
ufoo trace --agent <id-or-nickname> --follow
ufoo metrics --json > baseline.json
ufoo metrics --baseline baseline.json --json
```

MCP 同步提供只读工具 `read_agent_trace` 与 `read_agent_metrics`。详见 [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)。

### Online 远程中继（`ufoo online`）

默认接入公开服务 `https://online.ufoo.dev`，也支持本地自建 WebSocket 房间与收件箱：

```bash
ufoo online server --host 127.0.0.1 --port 8787
ufoo online token codex:abc123 --nickname builder
ufoo online room create --nickname builder --name review-room --type private --password secret
ufoo online connect --nickname builder --room <room_id> --room-password secret
ufoo online send --nickname builder --room <room_id> --text "handoff ready"
ufoo online inbox builder --unread
```

---

## 模型 Provider 与配置说明

项目配置保存在 `.ufoo/config.json`；用户全局的 `ucode`、daemon、`browser` 与 `mac` 配置保存在 `~/.ufoo/config.json`。在面板中输入 `/settings`（或点击底栏 Provider 名称）即可交互式切换 Provider、模型、自定义网关地址与思考强度（`low` / `medium` / `high` / `xhigh` / `max`）。

- **Codex / OpenAI**：默认 `gpt-6.1-sol`（`medium` 思考强度，辅助模型 `gpt-6-luna`），自动刷新本机 Codex 登录凭据。
- **Claude / Anthropic**：默认 `claude-opus-5-5`（辅助模型 `claude-haiku-5-5`），启用自适应思考并流式展示思考摘要。
- **Antigravity (`agy`)**：在 `ufoo` 中选择 `/provider agy` 或运行 `ucode --provider agy`（默认主模型 `gemini-4-carbon-high`，辅助模型 `gemini-4-hydrogen-high`）。首次执行 `agy` 登录后，自动复用 macOS 钥匙串 / Linux Secret Service / Cloud Code 凭据（支持 `UFOO_AGY_AUTH_PATH`、`UFOO_AGY_ACCESS_TOKEN`、`UFOO_AGY_PROJECT_ID` 覆盖）。
- **Grok Build & Kimi Code**：支持 `ugrok` / `grok-cli`（默认 `grok-4.6`）与 `ukimi` / `kimi-cli`。
- **自定义 OpenAI 兼容网关**：设置 `agentProvider: "custom"`（或全局 `ucodeBaseUrl` / `ucodeApiKey`），默认走 Chat Completions，URL 以 `/responses` 结尾时自动启用 OpenAI Responses 协议。

项目 `.ufoo/config.json` 示例：

```json
{
  "launchMode": "auto",
  "daemonTopology": "global",
  "agentProvider": "codex-cli",
  "agentModel": "",
  "agentAuxModel": "",
  "agentThinking": "medium",
  "autoResume": false
}
```

全局 `~/.ufoo/config.json` 示例：

```json
{
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-6.1-sol",
  "ucodeAuxModel": "",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-...",
  "browser": { "enabled": true, "backend": "ufoo-extension" },
  "mac": { "enabled": true, "hud": true, "takeoverGuard": true }
}
```

> **关于 Internal Codex 宿主访问权限**：面板内嵌的 Codex SDK 线程默认启用完整宿主用户态访问（`danger-full-access`、开启网络、`approvalPolicy: never`，受当前操作系统用户权限边界约束），以便顺畅访问模拟器、ADB、Gradle 与全局编译缓存。升级后请重启已加载的旧 worker 使新策略生效。

---

## 源码目录与开发发布

```text
crates/ufoo-tui/        Rust ratatui 终端渲染引擎（chat 与 ucode 共用）
extensions/ufoo-browser/ ufoo Browser Chrome MV3 扩展源码
src/
  app/                  Chat 客户端状态与 CLI 命令组（setup、browser、mac、trace、metrics 等）
  ui/                   Rust TUI Socket 宿主、多分屏会话管理与纯格式化工具
  runtime/              全局/项目 daemon、MCP HTTP/stdio、终端适配器、browser 与 mac 运行时
  orchestration/        路由策略、Group 模板校验/启动与 Solo 角色管理
  agents/               共享 Runtime 核心、Context Engine V2、Capabilities、Profiles、Providers、Prompts
  code/                 原生 ucode 宿主、文件/Shell/后台工具、Plan Mode 与会话存储编解码
  coordination/         事件总线、架构决策、共享记忆、输入历史、任务报告与文件锁状态库
  tools/                Controller 与 Worker 共享 MCP 工具 Schema 及处理器
  online/               WebSocket 在线中继服务端、客户端、房间与收件箱
SKILLS/                 默认安装的 4 个核心 Agent 技能
OPTIONAL_SKILLS/        按需安装的外部宿主自唤醒技能（ufoo-bus-poll）
templates/groups/       内置多 Agent 协作流模板
```

完整的模块边界与维护约束请参阅 [docs/PROJECT.md](docs/PROJECT.md)。

### 本地开发与测试

```bash
npm install
npm run pack:tui          # 编译并将 ufoo-tui 放入 dist/tui/<platform>-<arch>/
cargo test -p ufoo-tui    # 运行 Rust 渲染器单元测试
npm test                  # 运行完整 Jest 测试套件
```

可选真机集成测试：

```bash
# 真实 Chrome 隔离测试配置（使用临时空白 Profile，绝不触碰个人日常数据）
UFOO_TEST_BROWSER=1 npm test -- --runTestsByPath test/integration/browser-existing-chrome.test.js

# macOS 独立 Agent 鼠标指针隔离测试（仅向临时自建 AppKit 测试窗口发送事件）
UFOO_TEST_MAC_POINTER=1 npm test -- --runTestsByPath test/integration/mac-independent-pointer.test.js
```

### 发布与日常排障

- **版本发布**：推送 `v*` tag（`npm version patch && git push --follow-tags`）触发 `.github/workflows/release.yml`，自动通过全量 CI 校验、编译四平台 `ufoo-tui` 二进制并发布至 npm。
- **清理失效项目记录**：使用 `ufoo project prune` 预览已删除目录的历史注册记录，`ufoo project prune --apply` 将其安全归档至 `~/.ufoo/projects/archive/`。
- **Codex 目录权限受限**：若默认 `~/.codex` 不可写，可在启动前执行 `export CODEX_HOME="$PWD/.ufoo/codex"`。

## 许可证

UNLICENSED。详见 [LICENSE](LICENSE)。
