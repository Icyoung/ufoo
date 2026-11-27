# ufoo

[English](README.md) · [官网](https://ufoo.dev) · [项目架构指南](docs/PROJECT.md) · [可观测性与指标](docs/OBSERVABILITY.md) · [文档目录](docs/README.md)

**多 Agent 工作区控制面与协作编程运行时（SDK + ACP + MCP）。** 通过 **原生 macOS 桌面应用**、**Rust TUI 终端面板** 与 **零知识端到端加密 Web/移动端 PWA**，由单一本机守护进程统一编排 Codex、Claude、Antigravity、Gemini CLI、OpenCode、Kimi、Goose、Grok 与原生 `ucode` 子 Agent。

npm 包：[u-foo](https://www.npmjs.com/package/u-foo) · 远程 Web 客户端：[online.ufoo.dev/remote](https://online.ufoo.dev/remote/)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![CI](https://github.com/Icyoung/ufoo/actions/workflows/ci.yml/badge.svg)](https://github.com/Icyoung/ufoo/actions/workflows/ci.yml)
[![macOS Desktop Build](https://github.com/Icyoung/ufoo/actions/workflows/macos-desktop.yml/badge.svg)](https://github.com/Icyoung/ufoo/actions/workflows/macos-desktop.yml)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue.svg)](https://github.com/Icyoung/ufoo)

---

## 核心特性（v5）

ufoo 为代码仓库内的所有 AI Agent 提供统一控制面、共享记忆与编排运行时，同时不绑定单一厂商 CLI：

- **原生 macOS 桌面端（`Ufoo.app`）**：基于 Tauri v2 + React/Tailwind 构建并内置完整 Node + Rust 运行时。支持 Main / Side / Multi 可视化工作流画布、实时 Git Diff 与文件/文档检查器、审批收件箱（Approval Inbox）、命令面板（`⌘K`）、视图前进/返回历史（`⌘[` / `⌘]`）、同行 Agent 协作折叠卡片、图片/文件拖拽附件，以及 `ufoo app` 终端一键唤起。
- **零知识端到端加密远程 Web / 移动 PWA（`ufoo remote`）**：在手机或任意浏览器打开专属地址 `https://online.ufoo.dev/remote/<device_id>` 即可远程操控本机 Mac 会话并审批操作。一次扫码配对（双向 HMAC 证明 + 公钥指纹校验），支持 WebRTC P2P 直连与中继回退，全程使用 ECDH P-256 + HKDF-SHA256 + AES-256-GCM 端到端加密。
- **三层 Agent 互通架构（SDK + 双向 ACP + MCP）**：
  - **原生 SDK 内嵌 Worker**：直连 Codex SDK（`codex`）、Claude Agent SDK（`claude`）、Antigravity（`agy`）与原生 `ucode`。
  - **双向 ACP 协议**：既可作为 ACP Client 托管任意 ACP 兼容 CLI（内置 `gemini`、`opencode`、`kimi`、`goose`、`grok` 及自定义 `acpAgents`），也可作为 ACP Server（`ufoo acp`、`ucode --acp`）直接接入 Zed、JetBrains、Neovim、T3 Code。
  - **聚焦单例 MCP**：自动向受控 Worker 注入协作工具，并通过用户级全局守护进程（`~/.ufoo/run/ufoo.sock`）为 Codex App/IDE、Cursor、Antigravity App 提供统一 Streamable HTTP 与 `ufoo mcp` stdio 代理。
- **实时共享工作区与模型自主 Worktree**：框架层不再强制创建或绑定 Agent 到独立 Worktree，组内与跨组 Agent 直接实时共享主仓库代码；模型可按需自行创建并自由跨本仓库任意关联 Git Worktree 读写协作。
- **Group 停稳自动汇总与全员历史检索（`read_agent_history`）**：当一个 Group 的全部成员停稳且消息队列清空后，daemon 自动聚合所有成员最后一轮输出并唤醒 `ufoo` 做本轮总结；`ufoo` 也可随时通过 `read_agent_history` 按昵称、Group 或关键词检索项目内任意活跃/已归档 Agent 的历史消息。
- **一体化 Rust TUI 面板（`ufoo` & `ucode`）**：与桌面端共享 `ufoo-ui/1` 协议和后台持久守护进程（macOS 支持 `ufoo daemon service install` 托管至 `launchd`），终端内即可切换 `main` / `side` / `multi` 分屏布局。
- **原生 Agent Runtime 与 Context Engine V2**：KV-Cache 友好的滑动窗口、自动 `<turn_context>` 主题索引、跨窗口按需检索 `recall_turn`、结构化 `plan_graph` / Plan Mode、崩溃安全日志、目录写租约与**后台命令零 Token 自动唤醒**。
- **日常 Chrome（`browser`）与 macOS 桌面自动化（`mac_app`）**：通过 `ufoo Browser` MV3 扩展与 `BrowserBroker` 标签页级归属操控已登录的日常 Chrome；通过 `AXUIElement` 快照、1:1 逻辑点截图与独立 **Agent 鼠标** 操控原生 macOS 应用并在人工介入时即时避让。
- **多 Agent Group 编排、共享记忆与可观测性**：内置 7 套专业协作流模板、架构决策（`/ctx decisions`）、持久化共享记忆（`ufoo memory`）、证据门控验收，以及零模型调用的 `ufoo trace` / `ufoo metrics`。

---

## 环境要求与安装

### 环境要求

- **macOS 桌面应用**：macOS 12.0+（Apple Silicon `arm64` 或 Intel `x64`，`.dmg` 已内置自包含 Node.js 与 `ufoo-tui`）。
- **CLI / TUI**：**Node.js 18.17+**（可选的 `ufoo Browser` Playwright MCP 运行时需要 **Node.js 20+**），支持 **macOS** 与 **Linux**（npm 包内置 `darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64` 的 `ufoo-tui` 二进制）。
- 按需安装你要调度的第三方 CLI 或登录对应账号（`codex`、`claude`、`agy`、`gemini`、`opencode`、`kimi`、`goose`、`grok`）。

### 方式一：下载 macOS 桌面端（`.dmg`）

前往 [GitHub Releases](https://github.com/Icyoung/ufoo/releases) 下载对应架构（Apple Silicon `arm64` / Intel `x64`）的 `.dmg` 安装包，将 `Ufoo.app` 拖入 `/Applications` 即可使用。可在设置中或命令行一键安装 `ufoo` / `ucode` CLI 软链：

```bash
ufoo app --install-cli --zshrc
```

> 若运行未经过 Apple 公证的预览构建，首次请右键 `Ufoo.app` → **打开**（或执行 `xattr -dr com.apple.quarantine /Applications/Ufoo.app`）。

### 方式二：通过 npm 安装 CLI 与 TUI

```bash
npm install -g u-foo
ufoo setup
```

`ufoo setup` 会交互式引导安装可选组件（如 `ufoo Browser`，也可显式传 `--browser=install` 或 `--browser=skip`）。

### 方式三：从源码构建

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm --prefix apps/desktop ci
npm run pack:tui          # 编译并暂存 Rust TUI 二进制
npm link                  # 全局链接 ufoo 与 ucode

# 可选：构建 macOS 桌面应用（需 Rust 与 Xcode Command Line Tools）
npm run pack:desktop
```

### 提供的命令入口

v5 已移除旧版 PTY CLI 包装器（`uclaude`、`ucodex`、`uagy`、`ugrok`、`ukimi`）与 `node-pty`，全面迁移至原生 SDK + ACP + MCP。

| 命令 | 职责说明 |
|---|---|
| `ufoo` | 主 CLI、Rust TUI 面板、桌面端唤起（`ufoo app`）、ACP 服务端（`ufoo acp`）、端到端远程配对（`ufoo remote`）、全局/项目 daemon、MCP 服务与 stdio 代理、`browser` / `mac` 管理、group、bus、context、memory、report 与 trace/metrics。 |
| `ucode` | 原生 ufoo 编程 Agent CLI/TUI 及独立 ACP 服务端（`ucode --acp`），共享可组合 runtime、Context Engine V2、`browser` 与 `mac_app` 能力。 |

---

## 快速开始

### 1. 打开桌面端或终端 TUI

```bash
cd your-project
ufoo init --targets context,bus
ufoo app      # 在 Ufoo macOS 桌面端打开当前项目
ufoo          # 或在终端启动 Rust TUI 协作面板
ufoo -g       # 或打开全局多项目路由视图
```

在对话面板中直接和主 Agent 协作，或随时拉起子 Agent 与团队流：

```text
> /launch codex reviewer
> /launch claude builder
> /launch agy researcher
> /launch acp:opencode refactor
> @reviewer 检查当前 diff 并列出上线风险
> /group run build-lane instance=auth-refactor
```

### 2. 配对手机或远程浏览器（零知识端到端加密）

在桌面端打开 **Settings → Remote Access**，或在终端执行：

```bash
ufoo remote pair          # 生成终端二维码、8 位一次性配对码与专属 /remote/<device_id> 链接
ufoo remote status        # 查看中继连接状态、设备公钥指纹与专属远程地址
ufoo remote devices       # 查看所有已配对的远程设备
ufoo remote revoke <id>   # 立即吊销指定远程设备的访问权限
```

手机扫码或访问 `https://online.ufoo.dev/remote/<device_id>` 即可无缝接入——所有数据均在浏览器与本机 Mac 之间端到端加密（`ECDH P-256 + HKDF-SHA256 + AES-256-GCM`），支持 WebRTC P2P 直连与零知识中继自动回退。

### 3. 通过 ACP 或全局 MCP 接入外部编辑器与客户端

- **ACP 宿主（Zed、JetBrains、Neovim、T3 Code）**：
  ```bash
  ufoo acp                  # 通过 ACP stdio 暴露项目主 Agent
  ucode --acp               # 通过 ACP stdio 暴露独立 ucode
  ```
- **Codex App、Codex CLI 与 Codex IDE 插件**（鉴权 Streamable HTTP MCP）：
  ```bash
  ufoo -g
  ufoo mcp configure codex  # 可加 --dry-run 预览脱敏后的配置变更
  ```
- **Cursor、Antigravity App 及其他 MCP 客户端**（无状态 stdio 代理）：
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
  随时使用 `ufoo mcp status` 和 `ufoo mcp restart` 检查或重启全局唯一 MCP 监听器。

### 4. 在 macOS 上托管后台守护进程（`launchd`）

```bash
ufoo daemon service install
ufoo daemon service status
ufoo daemon service restart
ufoo daemon service uninstall
```

---

## 桌面端与 TUI 交互指南

`Ufoo.app` 与 `ufoo-tui` 共享同一套 `ufoo-ui/1` 协议。所有长任务状态由后台 daemon 持有，关闭窗口或终端不会中断运行中的任务，重新连接会自动回放完整流式输出与工具树。

### 三种工作区布局与快捷键

支持在 `main → side → multi` 三种视图间快速切换：
- **Main**：单窗聚焦当前主 Agent、全局路由或单个子 Agent。
- **Side**：左侧项目主 Agent + 右侧当前激活子 Agent 分屏协作。
- **Multi**：多 Agent 可视化工作流画布 / 多窗格同屏监控与交互。

| 端 | 快捷键 | 功能说明 |
|---|---|---|
| 桌面端 | `⌘K` | 打开命令面板，快速搜索并跳转项目、Agent 与常用动作。 |
| 桌面端 | `⌘[` / `⌘]`（或 `Alt+←` / `Alt+→`） | 在已访问过的项目与 Agent 视图间前进 / 返回。 |
| 桌面端 | `⌘B` / `⌘⌥B` | 折叠或展开左侧栏 / 右侧工作区检查器（Git Diff、文件、文档）。 |
| TUI | `Ctrl+W` / `Ctrl+Q` | 循环切换 `main → side → multi` 布局 / 退出分屏回到 `main`。 |
| TUI | `Tab` / `Esc` | 在可见窗格间切换焦点或返回主输入框（不中断子任务）。 |
| TUI | `Ctrl+O` | 展开或收起当前窗格最新一组思考过程 / 工具调用树。 |
| TUI | `Ctrl+C` / `Ctrl+X` | 取消焦点子 Agent 当前轮次（`Ctrl+C`）或关闭选中子 Agent（`Ctrl+X`）。 |

### 常用 Slash 命令

```text
/status                         查看项目、daemon 与在线 Agent 状态概览
/launch <agent> [nickname]      启动内嵌 SDK 或 ACP 子 Agent（codex、claude、agy、ucode、acp:<id>）
/resume                         恢复已保存的子 Agent 或整组 Group（group:<id>）
/task list | inspect | cancel   管理独立上下文的后台编码任务
/answer <interaction-id> <text> 回复处于 ask_user 等待状态的任务提问
/session show | new             查看当前会话或基于最新设置开启新主会话
/settings                       配置主 Agent 或 ucode 的 provider、自定义网关、模型与思考强度
/group templates | run | status 启动、预览与管理多 Agent Group 协作流
/ctx status | decisions | doctor 查看架构决策与上下文健康状态
/bus status | list | send       检查事件总线队列并向任意在线 Agent 发送消息
/project list | switch <n>      查看或切换已注册项目
/open /path/to/project          直接挂载并切换到指定目录项目
/doctor                         自检 CLI 版本、ACP 运行时与 MCP 配置
```

---

## 原生 Agent Runtime 与 `ucode`

项目主 Agent、可写独立子任务（`manage_tasks`）与 `ucode` 共用分层可组合的原生运行时（`src/agents/runtime/`）。

### Context Engine V2 与 `recall_turn`

- **KV-Cache 稳定的滑动窗口**：默认保留 `Step=2` 对齐的近 5 轮完整原始对话（热点话题可在 45% 历史预算内弹性扩展至 10 轮），最大化命中大模型前缀缓存。
- **瞬态 `<turn_context>` 注入**：仅在当前轮次用户消息上挂载轻量 `<topic_map>` 与 `<relevant_turns>` 摘要，落盘与归档前自动剥离，不污染历史记录。
- **可选后台异步富化（Aux Model）**：配置 `agentAuxModel` 或 `ucodeAuxModel` 后，后台异步精炼历史轮次摘要与二阶段语义召回；未配置时零额外模型请求。
- **确定性溢出淘汰与 `recall_turn`**：超长上下文采用 Level 1–3 确定性分级裁剪，避免阻塞式摘要调用；模型可随时调用 `recall_turn` 检索窗口外历史或分页精读原始对话。

### Plan Mode、执行预算与目录写租约

- **Plan Mode 与 `plan_graph`**：输入 `/plan on`（或模型调用 `plan_graph create` 后自动开启），拦截直接副作用工具并按 `plan_graph` 节点有序推进；执行 `/plan off` 退出。
- **执行与死循环防护**：默认不限制工具总次数，单任务超时上限 12 小时（支持 `ucode --max-tool-calls <N|none>`、`UFOO_UCODE_MAX_TOOL_CALLS`、`UFOO_UCODE_MAX_TOOL_ERRORS`、`UFOO_UCODE_TASK_TIMEOUT_MS` 覆盖）。连续报错 3 次告警、5 次熔断（滑动 20 次满 12 次熔断），自动阻断重复死循环。
- **崩溃安全与并发写锁**：每轮完整批次落盘后再发起下一轮请求；同目录写操作共享互斥租约，独立 `git worktree` 可完全并行写入。

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

支持 `log_contains`、`file_exists`、`port_open`（`127.0.0.1`）以及进程退出通知（默认开启，`wake.onExit: false` 可关闭）。

### Agent 技能安装与同步

`npm install` 自动维护 `ufoo`、`ufoo-bus`、`ufoo-context`、`ufoo-online` 四个核心技能软链，且绝不覆盖用户自建文件：

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

项目主 Agent、可写独立子任务与 `ucode` 均内置 `browser` 和 `mac_app` 工具；截图通过多模态 Vision 数据块直传模型并在识别后自动清理回收上下文。

### 1. 日常 Chrome 操控（`browser` / `ufoo browser`）

直接连接你正在使用、已登录账号的日常 Chrome（需 **Node.js 20+**），绝不强开空白浏览器或关闭用户窗口：

```bash
ufoo setup --browser=install     # 安装可选 Playwright MCP 运行时并注册 Native Messaging Host
ufoo browser install --dev       # 从 extensions/ufoo-browser/ 加载解压扩展
ufoo browser status [--json]
ufoo browser doctor
ufoo browser enable | disable | update | uninstall
```

- **`BrowserBroker` 标签页级隔离**：`ufoo Browser` MV3 扩展通过 Chrome Native Messaging 连接 `~/.ufoo/browser/private/broker.sock`，按 `tabId` 认领归属权，冲突返回 `browser_tab_busy`。
- **兼容模式**：同时支持官方 Playwright Extension（`backend: "playwright-extension"`）与显式 CDP 端点（`UFOO_BROWSER_CDP_ENDPOINT`）。

### 2. macOS 桌面应用与独立 Agent 鼠标（`mac_app` / `ufoo mac`）

通过自动编译缓存的零依赖原生 Swift 助手（`~/.ufoo/mac/bin/`）操控各类 Cocoa、SwiftUI 与 Electron 应用：

- **AX 无障碍结构化操控（`AXUIElement`）**：`list_apps`、`list_windows`、`snapshot`（`@e1..@eN` 引用、菜单栏探测与关键词过滤）、`ax_action`、`launch_app`、`focus_app` 与 `manage_window`。
- **1:1 逻辑点无阴影截图**：按窗口（`-o -l`）、区域或显示器截图，自动缩放至 1:1 逻辑点并通过 `screenshotId` 精准映射坐标（无 Retina `2x` 偏移）。
- **独立 Agent 鼠标与人工接管避让**：窗口定向投递事件并展示不可被截图捕获的悬浮 **Agent Mouse HUD**，绝不移动物理鼠标；晃动鼠标、点击目标窗口或按下 `Esc` 即刻避让。

```bash
ufoo mac status [--json]         # 查看助手状态、显示器信息与系统权限
ufoo mac permissions             # 触发授权并打开 macOS「辅助功能 / 屏幕录制」设置面板
ufoo mac doctor                  # 自检 Swift 编译缓存、守护进程 Socket RPC 与权限项
ufoo mac hud on | off | toggle   # 开关 Agent 鼠标可视化悬浮层
ufoo mac enable | disable | stop
```

---

## 运行架构与多 Agent 编排

```text
交互端:
  Ufoo.app (Tauri v2 + React) ──┐
  ufoo / ucode (Rust ufoo-tui) ─┼──(ufoo-ui/1)──> desktopUiHost / rustChatHost
  Web/Mobile PWA (E2EE P2P/WS) ─┘                     │
                                                      v
                                    GlobalDaemon (~/.ufoo/run/ufoo.sock)
                                      ├── 按项目隔离的 ProjectRuntime
                                      ├── 受控 Worker: Codex SDK · Claude SDK · agy · ucode · ACP Client
                                      ├── 智能 Git Worktree 管理器 & 7 套 Group 协作模板
                                      ├── 全局单例 Streamable HTTP MCP + ufoo mcp stdio 代理
                                      └── .ufoo/ 状态库（事件总线、架构决策、共享记忆、历史、报告、日志）

外部 ACP 宿主 (Zed / JetBrains / Neovim) ──(ufoo acp / ucode --acp)──> ProjectRuntime
```

### 内置多角色 Group 模板（`templates/groups/`）

内置 `build-lane`、`build-ultra`、`design-system`、`product-discovery`、`ui-plan-review`、`ui-polish`、`verify-ship` 7 套协作流水线模板：

```text
/group templates
/group template show build-lane
/group run build-lane dry_run=true
/group run build-lane instance=release-v5
/group status
/group diagram build-lane mermaid
/group stop release-v5
```

### 决策、共享记忆、任务报告与可观测性

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

# 离线全链路追踪与性能指标（免模型调用）
ufoo trace <task-id> --json
ufoo trace --agent <id-or-nickname> --follow
ufoo metrics --json > baseline.json
ufoo metrics --baseline baseline.json --json
```

MCP 同步提供只读工具 `read_agent_trace` 与 `read_agent_metrics`。详见 [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)。

---

## 模型 Provider 与配置说明

项目配置保存在 `.ufoo/config.json`；用户全局的 `ucode`、daemon、`browser`、`mac` 与 `remote` 配置保存在 `~/.ufoo/config.json` 与 `~/.ufoo/remote/`。

- **Codex / OpenAI**：内嵌 `@openai/codex-sdk`，自动刷新本机 Codex OAuth 凭据。
- **Claude / Anthropic**：内嵌 `@anthropic-ai/claude-agent-sdk`，支持自适应思考与流式思考摘要。
- **Antigravity (`agy`)**：原生 `agy` 线程 Provider，自动复用 macOS 钥匙串 / Linux Secret Service / Cloud Code 凭据（支持 `UFOO_AGY_AUTH_PATH`、`UFOO_AGY_ACCESS_TOKEN`、`UFOO_AGY_PROJECT_ID` 覆盖）。
- **通用 ACP Agent**：内置 `gemini`、`opencode`、`kimi`、`goose`、`grok` 预设，并支持在配置中通过 `acpAgents` 注册自定义 ACP 命令。
- **自定义 OpenAI 兼容网关**：设置 `agentProvider: "custom"`（或全局 `ucodeBaseUrl` / `ucodeApiKey`），URL 以 `/responses` 结尾时自动启用 OpenAI Responses 协议。

项目 `.ufoo/config.json` 示例：

```json
{
  "daemonTopology": "global",
  "groupAutoSummarize": true,
  "agentProvider": "codex-cli",
  "agentModel": "",
  "agentAuxModel": "",
  "agentThinking": "medium",
  "autoResume": false,
  "acpAgents": []
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

---

## 源码目录与开发发布

```text
apps/desktop/           React + TypeScript + Tailwind 前端（桌面端与远程 Web/Mobile PWA 共用）
crates/
  ufoo-desktop/         Tauri v2 macOS 桌面宿主（Ufoo.app 与自包含运行时打包）
  ufoo-tui/             Rust ratatui 终端渲染引擎（chat 与 ucode 共用）
extensions/ufoo-browser/ ufoo Browser Chrome MV3 扩展源码
src/
  app/                  Chat 客户端状态与 CLI 命令组（app、remote、setup、browser、mac、trace、metrics 等）
  ui/                   桌面 UI 宿主、E2EE 远程中继桥接、Rust TUI 宿主与 Git/工作区检查器
  runtime/              全局 daemon、launchd 服务、项目运行时、MCP HTTP/stdio、Worktree 管理器、browser 与 mac 运行时
  orchestration/        路由策略、Group 工作流图/模板校验与 Solo 角色管理
  agents/               共享 Runtime 核心、Context Engine V2、Capabilities、Profiles、SDK/ACP Providers、Prompts
  code/                 原生 ucode 宿主、文件/Shell/后台工具、Plan Mode 与会话存储编解码
  coordination/         事件总线、架构决策、共享记忆、输入历史、任务报告与文件锁状态库
  tools/                Controller 与 Worker 共享 MCP 工具 Schema 及处理器
  online/               零知识 E2EE 中继服务端、加密原语、二维码生成与 PWA 静态托管
SKILLS/                 默认安装的 4 个核心 Agent 技能
OPTIONAL_SKILLS/        按需安装的外部宿主自唤醒技能（ufoo-bus-poll）
templates/groups/       内置多 Agent 协作流模板
```

完整的模块边界与维护约束请参阅 [docs/PROJECT.md](docs/PROJECT.md)。

### 本地开发与测试

```bash
npm install
npm --prefix apps/desktop ci
npm run pack:tui            # 编译并将 ufoo-tui 放入 dist/tui/<platform>-<arch>/
npm run desktop:ui:build    # 类型检查并构建 apps/desktop 前端
cargo test -p ufoo-tui      # 运行 Rust 渲染器单元测试
npm test                    # 运行完整 Jest 测试套件
```

### CI、发布与 macOS 桌面构建

- **CI（`.github/workflows/ci.yml`）**：在 Node 18/20/22（Ubuntu & macOS）运行全量 Jest 单测、编译测试 `ufoo-tui`，并校验 `apps/desktop` 前端构建。
- **macOS 桌面端构建（`.github/workflows/macos-desktop.yml`）**：自动构建自包含的 Apple Silicon（`arm64`）与 Intel（`x64`）`Ufoo.app` 及 `.dmg` 安装包。当 `master` 推送涉及桌面端/打包文件变更时自动产出 Artifacts，也可在 Actions 页面手动触发（`workflow_dispatch` 可选架构与是否发布 Release）；推送 `v*` tag 时自动将 `.dmg` 与 `SHA256SUMS.txt` 挂载至对应 GitHub Release。若在仓库 Secrets 配置 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY` 与 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`，会自动执行 Apple Developer ID 签名与公证；未配置时自动执行 ad-hoc 签名以确保 Apple Silicon 正常运行。
- **npm 发布（`.github/workflows/release.yml`）**：推送 `v*` tag（`npm version patch && git push --follow-tags`）触发完整 CI 校验、四平台 `ufoo-tui` 编译并发布 `u-foo` 至 npm。

### 日常排障

- **清理失效项目记录**：使用 `ufoo project prune` 预览已删除目录的历史注册记录，`ufoo project prune --apply` 将其安全归档至 `~/.ufoo/projects/archive/`。
- **Codex 目录权限受限**：若默认 `~/.codex` 不可写，可在启动前执行 `export CODEX_HOME="$PWD/.ufoo/codex"`。

## 许可证

UNLICENSED。详见 [LICENSE](LICENSE)。
