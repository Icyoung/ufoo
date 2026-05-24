# ufoo-agent API Loop 重构方案（Plan）

Date: 2026-04-20
Status: post-v1-backlog
Related decision:
- `.ufoo/context/decisions/0282-ufoo-source-adopt-api-backed-loop-architecture-for-ufoo-agent.md`

## 实现进度审计（2026-04-20，2026-04-26 更新）

本节基于当前仓库代码与相关单测审计，更新计划的实际落地状态，避免继续把本文视为纯规划稿。

总体判断：

- `Phase 0` 已落地：feature flag、loop runtime 形态、tool schema 样板、observability/shadow 基础设施均已入树。
- `Phase 1a` 已基本落地：`CodexSdkThread`、Codex event translator、`internalRunner` 的 codex thread runtime 接线已存在；2026-04-26 已补 Codex direct-upstream credential bridge 与 HTTP/SSE transport，默认直连 API。
- `Phase 1b` 已基本落地：Claude OAuth reader、`ClaudeApiThread`、Claude translator、prompt caching request builder 与 cache token observability 映射均已存在；runner 不再把 direct-provider credential errors 回退到 CLI，剩余主要是生产环境命中率与 shadow/稳定性事实回填。
- `Codex` 已能直接读取本机 `~/.codex/auth.json` 或 `OPENAI_API_KEY` 形成 upstream credential descriptor；`ufoo status` 与 chat `/status` 暴露本机凭证 preflight，不新增单独登录命令。
- `ucode` 线程化/SDK 化未实现，但已从 v1 主线移到文档后部的后续独立议题，不阻塞当前方案收口。
- `Phase 2` 已落地：router fast path、confidence gate、dispatch 失败升级、controller mode/flag 切换均已存在。
- `Phase 3` 已落地：limited loop runtime、最小 controller tool 集、shadow/no-op guard、最大轮数/工具调用预算已存在；recent loop observability 摘要现已通过 status/dashboard 暴露 token / 轮数 / cache / tool 分布。
- `Phase 4` 已落地：`assistant_call` / helper-agent 运行路径、bridge/binary 和相关 schema 已删除；`promptLoop` 仅保留为无 helper 的单轮 finalize runner。

主要证据：

- Provider/runtime 接线：`src/agents/internal/internalRunner.js`
- Codex/Claude provider seam：`src/agents/providers/codexThreadProvider.js`、`src/agents/providers/claudeThreadProvider.js`、`src/agents/providers/claudeOauthTokenReader.js`
- Redactor / shadow diff：`src/runtime/privacy/redactor.js`、`src/runtime/privacy/shadowDiff.js`
- Fast path / shadow / flag：`src/runtime/daemon/promptRequest.js`、`src/orchestration/controller/routerFastPath.js`、`src/orchestration/controller/flags.js`
- Limited loop：`src/agents/controller/loopRuntime.js`
- Tool registry / tier 权限：`src/tools/schemaFixtures.js`、`src/tools/registry.js`
- Phase 4 仍未删除的兼容路径：`src/agents/controller/ufooAgent.js`、`src/runtime/daemon/promptLoop.js`

本次审计已补跑并通过以下相关测试：

- `test/unit/agent/internalRunner.test.js`
- `test/unit/agent/codexThreadProvider.test.js`
- `test/unit/agent/claudeThreadProvider.test.js`
- `test/unit/agent/claudeOauthTokenReader.test.js`
- `test/unit/daemon/promptRequest.test.js`
- `test/unit/daemon/promptRequest.loop.test.js`
- `test/unit/agent/loopRuntime.test.js`
- `test/unit/controller/routerFastPath.test.js`
- `test/unit/tools/registry.test.js`
- `test/unit/tools/handlers.test.js`
- `test/unit/tools/tier0Handlers.test.js`
- `test/unit/tools/tier2Handlers.test.js`
- `test/unit/agent/ufooAgent.test.js`
- `test/unit/daemon/promptLoop.test.js`

### 分期状态一览

| Phase | 当前状态 | 说明 |
| ----- | -------- | ---- |
| Phase 0 | 已完成 | 计划中的接口冻结产物大多已入树，文档本身应视为“实现+验收跟踪”而非纯设计稿。 |
| Phase 1a | 已完成 | Codex provider seam、translator、runner 接线、direct-upstream credential bridge、HTTP/SSE transport 与 thread rebuild 测试均已存在。 |
| Phase 1b-i | 已完成 | OAuth reader、schema/version 嗅探、refresh/锁与无凭据错误测试已存在。 |
| Phase 1b-ii | 已完成 | `ClaudeApiThread` 与 Claude event translator 已存在。 |
| Phase 1b-iii | 已完成（代码） | runner 已切 Claude thread provider，direct credential errors 直接暴露给调用方；Claude request 已支持静态/半静态 cache 段与 cache token observability；生产命中率仍需按真实流量回填。 |
| Phase 1 整体 | 大体完成 | provider seam、redactor、shadow diff、direct-upstream 主线已落地；剩余是更偏生产环境的验收与清理。 |
| Phase 2 | 已完成 | `router-api` fast path、低置信度/派发失败自动升级已存在。 |
| Phase 3 | 已完成 | `loop` mode、controller tool-call runtime、shadow side-effect guard 已存在；dashboard 已可见 recent loop token / round / cache / tool 分布摘要。 |
| Phase 4 | 已完成 | helper/`assistant_call` 运行路径、bin、assistant runtime 与 schema 已删除；兼容清理已落地。 |

## 1. 背景

当前 `ufoo-agent` 是单轮 JSON router：

- 输入：当前用户 prompt + bus/context/history 摘要
- 执行：临时调用 `codex` / `claude` CLI 或 native provider
- 输出：一次性 JSON（`reply`、`dispatch`、`ops`、`assistant_call`）
- 后续：由 daemon/controller 执行具体动作

这套模式的问题：

1. 没有显式 tool-call loop，无法稳定完成“先读状态，再决定，再执行”的多步编排。
2. 路由与编排都走重型 CLI 路径，不利于使用更快更小的模型做高频 route 判定。
3. `assistant_call` 承担了 controller 无法直接完成的探索/辅助工作，helper 路径已经成为补丁层。
4. 当前 `ufoo-agent` 不是可控 agent runtime，只是一次性调用底层模型并要求返回 JSON。

## 2. 目标

将 `ufoo-agent` 升级为一个 API-backed 的 controller agent，具备两种能力：

1. Fast routing
- 对纯路由意图，使用更快更小的模型，一次返回目标 agent / nickname / routing action。

2. Limited loop orchestration
- 对非纯路由意图，进入受限 tool-call loop。
- `ufoo-agent` 可以调用 controller tools 读取上下文、选择目标 agent、launch/dispatch/rename/cron。
- loop 以有限轮数完成，不演变为无限自治 agent。

非目标：

1. 不在 `ufoo-agent` 内实现 coding worker 的完整职责。
2. 不整体迁移 CLIProxyAPI 的管理后台、watcher、dashboard 或多余 provider 网关逻辑；仅迁移 Codex/Claude 直连上游 API 所需的 auth/transport/translator 最小核心。
3. 不在第一阶段支持任意 shell / 任意文件写入类工具。
4. 不改造 CLI 模式（`uclaude` / `ucodex` PTY 路径）。PTY 模式继续作为用户前台直连 CLI 的通道，本次重构只动 internal 模式。
5. 不保留 `assistant_call` 与 helper-agent 作为长期路径；重构终态是两者完全移除（详见 Phase 4）。

## 3. 预期结果

重构完成后，预期系统行为如下：

### 3.1 对用户可见

1. 用户发出“把这个交给谁”“继续哪个 agent”“要不要 launch”这类请求时，`ufoo-agent` 更快返回路由结果。
2. 用户发出“先看当前状态，再决定怎么编排”这类请求时，`ufoo-agent` 不再依赖临时 helper agent，而是自己完成多步 controller 工作。
3. controller 层能够使用更便宜更快的模型做路由，降低延迟与成本。

### 3.2 对系统可见

1. `ufoo-agent` 具有显式的 tool-call protocol 与 loop runtime。
2. Codex / Claude 的 provider 调用由 API-backed runtime 负责；其中 Codex 的终态目标是跳过本机 CLI runtime，直接调用上游 API。
3. `assistant_call` 与 helper-agent 代码路径完全移除，不保留长期 fallback。
4. Internal 模式的 worker（Codex / Claude）通过统一 tool registry 直接调用 ufoo 协调原语（bus 读写、decisions、dispatch 等），无需绕 controller。

## 4. 总体方案

总体方案分为四层。

### 4.1 Provider API Layer

新增 `ufoo` 内部 provider runtime，用于：

1. 读取 Codex / Claude Code 登录态或认证信息
2. 直接调用上游 HTTP / WebSocket API
3. 提供统一的请求/响应接口
4. 保真处理 tool-call / tool-output 事件

来源参考：

- `CLIProxyAPI` 的 Codex / Claude executor
- request/response translator
- websocket tool-call repair 能力

边界：

- 只抽协议层与必要的 auth/transport/translation
- 不引入完整 server、management API、watcher、dashboard

Auth 与凭据：

1. **Codex（2026-04-26 已实现）**：读取 `OPENAI_API_KEY` 或本机 `~/.codex/auth.json`，从 Codex OAuth token / ChatGPT account id 派生 direct-upstream credential descriptor；过期或近过期 token 由 refresh token 直连 `auth.openai.com/oauth/token` 刷新并原子写回原文件。
2. **Codex transport（2026-04-26 已实现）**：OAuth credential 走 `chatgpt.com/backend-api/codex/responses` SSE；API key credential 走 OpenAI-compatible chat completions。`ufoo-agent` 和 internal Codex thread provider 不再把 credential/schema/refresh 错误回退到 `codex` CLI。
3. **Codex 凭证可见性（2026-04-26 已实现）**：`ufoo status` 与 chat `/status` 展示本机 direct API credential preflight，包括来源、状态、transport、账号与过期时间；不新增单独登录命令，缺凭证时提示用户先完成本机 Codex 登录或设置 `OPENAI_API_KEY`。
4. **Claude**：从 `~/.claude/` 读取 Claude Code 的 OAuth token 作为 bearer 直连 Anthropic Messages API（对齐 CLIProxyAPI 做法）；无 OAuth token 且无 `ANTHROPIC_API_KEY` 时 direct provider 返回明确错误，不作为 ufoo-agent 主路径回退到 legacy `claude -p`。
5. 凭据读取路径（包括 Claude OAuth token 位置、token 刷新触发条件，以及 Codex direct-upstream bridge 的凭据来源）在 `config.js` 中集中声明；token refresh 写回仅允许到原文件，不复制第二份。
6. **Token refresh 写回**必须满足：
   - 原子写（写临时文件 + `rename`），不允许直接覆盖
   - 进程间 `flock` 互斥，避免两个 runner 同时刷新撞写
   - 按 profile 分路径（`~/.claude/profiles/<name>/` 或等价）绑定，不跨 profile 复用 token
   - 刷新失败保留旧 token，不清空原文件
7. 多 profile / 多账号隔离由上层调用方指定，provider runtime 不维护跨 profile 的全局单例 token。
8. 禁止把 token / refresh token 写入日志、tool-call payload、history 文件；走 secret redactor（具体切片层见 §10.7）。
9. Claude OAuth token 格式由 Claude Code 管理，upgrade 可能破坏兼容——见 §10.8 风险。
10. 若后续 provider 必须走本地 companion proxy，对 ufoo 暴露的仍必须是统一 API transport，而不是把 CLI spawn 重新塞回 main path。

License 与来源标注：

1. 从 `CLIProxyAPI` 搬运的片段需在文件头保留原 license 头 / 归属声明。
2. 若原项目 license 与 ufoo 不相容，改为重写而非搬运，并在文档中记录。

### 4.2 Translator Layer

负责在 `ufoo` 的内部消息格式与上游 provider 格式之间转换。两侧 provider 的源事件格式完全不同，translator 必须把它们归一化为同一套 ufoo event：

| Provider | 源事件                                                                       | 包 / 路径                       |
| -------- | ---------------------------------------------------------------------------- | ------------------------------- |
| Codex    | SDK 异步事件：`thread.started` / `turn.started` / `item.completed` / `turn.completed` / `turn.failed` | `@openai/codex-sdk`             |
| Claude   | Messages API SSE / 结构化响应：`message_start` / `content_block_delta` / `tool_use` / `message_delta` | `@anthropic-ai/sdk` + OAuth token |

翻译目标：

1. `ufoo request -> provider request`
2. `provider response/tool events -> ufoo events`

重点保留：

1. tool definitions
2. tool choice
3. tool call IDs
4. tool output events
5. streaming event normalization

归一化后的 ufoo event schema 至少包含：`thread_started` / `turn_started` / `text_delta` / `tool_call` / `tool_result` / `turn_completed` / `turn_failed` / `usage`。Loop runtime 只消费这一套事件，不关心 provider。

### 4.3 ufoo-agent Loop Runtime

新增 controller loop runtime，执行流程：

1. 组装 system + context + tool schema
2. 调用 provider model
3. 解析 tool call 或 final answer
4. 执行 tool
5. 将 tool result 回填给模型
6. 继续下一轮
7. 达到 stop condition 后返回最终 controller action

约束：

1. 默认最多 `3-5` 轮（初值基于"读状态 + 决策 + 执行"三段常见形态；Phase 3 上线后按真实分布调整）。
2. 工具白名单。
3. 写操作和 launch 类操作可额外加审计或 guard。
4. 单次 loop token 预算与墙钟超时硬约束；超预算立刻中止并回退到 fast path 或 `assistant_call` fallback。
5. 每轮产出 structured event（见 §14 Observability），不依赖模型自述。

错误与并发语义：

1. Tool 执行失败：把结构化 error 回填给模型，最多重试一次同一 tool；连续两次失败则终止 loop 返回 fallback。
2. Provider 流式断开：translator 层保底重连一次；仍失败则终止 loop。
3. Loop 进行中用户再次发消息：默认排队到当前 loop 结束后处理；新消息若为显式 cancel 则立即中止 loop。
4. 崩溃 / 重启：loop state 不做跨进程持久化，重启后丢弃未完成 loop；用户侧可见一条 cancelled event。

### 4.4 Tool Layer

将当前 `dispatch`、`ops`、`assistant_call` 背后的 controller 能力显式工具化。

### 4.5 Internal runner SDK 化

当前 `src/agents/internal/internalRunner.js` + `src/agent/cliRunner.js` 的实现存在结构性问题：

1. 每条 bus 消息 spawn 一个新子进程（`cliRunner.js:572`），冷启动 + fork 开销累积。
2. Session 连续性靠 `--session-id` 手工落盘 `stateFile` 维护，出错回滚靠 string match（`internalRunner.js:137`）。
3. 没有结构化 tool-event，tool-call 靠"让模型返回一段 schema JSON"近似实现。
4. Codex CLI 无 session，每次必须把全量 context 塞进 prompt，成本不可控。

重构方向：**把 `internalRunner` 的"消息处理"从 "spawn CLI + 解析 JSON"改为"调 ThreadProvider"**，保留其 poll 循环、bus 集成、activity state 发布等职责不变。

#### 4.5.1 ThreadProvider interface

```
interface ThreadProvider {
  startThread(opts): Thread
  resumeThread(threadId, opts): Thread
}

interface Thread {
  runStreamed(input, opts): AsyncIterable<UfooEvent>
  close(): Promise<void>
  id: string
}

interface RunStreamedOpts {
  tools?: ToolDefinition[]             // 从共享 registry 取，按调用者权限过滤
  toolExecutor?: (name, args) => Promise<unknown>  // 在 runner 进程内同步执行
  outputSchema?: JSONSchema            // 可选结构化输出
  budget?: { tokens?: number; wallMs?: number }
}
```

具体实现：

1. `CodexThreadProvider` — 默认使用 Codex direct-upstream transport；SDK seam 仅保留为兼容/实验入口，不承担主路径。
2. `ClaudeApiThread` — 使用 `@anthropic-ai/sdk` + OAuth token，直连 Messages API；thread 状态由 ufoo 侧 `messages: [...]` 数组维护，SDK 层无 thread 概念。
3. `UcodeThread` — 不纳入当前 v1 主线；ucode 的 native runner / thread 化路径在文档后部作为后续独立议题单列。

#### 4.5.2 Thread 生命周期

1. **Long-lived per subscriber**：每个 bus subscriber（即一个 agent session）维持一个常驻 Thread，进入 `internalRunner` 主循环时创建，退出 / SIGTERM 时销毁。
2. 不在磁盘持久化 thread state；runner 进程挂掉即丢，重启后是新 thread。**这是相对旧 `stateFile` 机制的功能回退**——旧路径用户可以靠落盘的 `cliSessionId` 在 runner 重启后恢复上下文，SDK 化之后丢失；Phase 1a 上线前需评估影响，必要时补一个 "opt-in SDK 恢复"的 escape hatch（Codex SDK 有 `resumeThread` 能力，基于 `~/.codex/sessions/` 文件，可作为后续增强）。
3. Thread 内部遇到连续 tool 失败 / provider error 时 runner 主动 `close()` 并重建。
4. 同一 subscriber 不允许并发 `runStreamed`；新消息在 runner 侧排队。SDK 自身对同 thread 并发调用的语义不保证（Codex SDK 文档未明示），runner 侧的串行化是唯一保障，Phase 0 需在集成测试里显式断言。
5. **SIGTERM / 优雅终止**：
   - 收到 SIGTERM 时 runner 先停止 drain bus queue，标记 `running=false`
   - 对所有常驻 thread 发 `close()`，等待当前 `runStreamed` 完成或超时（默认 10s）
   - Codex SDK 的子进程交由 SDK `close()` 清理；若 10s 内未退出则 `SIGKILL`（runner 记录为 `force_kill` observability 事件）
   - 未 drain 完的 bus 消息保留在 queue 里，下次 runner 启动继续处理（不丢）
   - Phase 1a 验收需包含"SIGTERM 中 streaming turn 被 drain 完才退出"的集成测试

#### 4.5.3 与当前 internalRunner 的差异

| 维度                 | 现状                                     | SDK 化后                                    |
| -------------------- | ---------------------------------------- | ------------------------------------------- |
| 进程模型             | 每条消息 spawn 一次 CLI                  | Codex 端 SDK 管 CLI 生命周期；Claude 端无 CLI |
| Session 管理         | 手工落盘 `stateFile`（用户可手动恢复）     | Codex thread 由 SDK 管；Claude 靠 messages 数组；用户手动恢复能力暂失（见 §4.5.2 #2） |
| 事件流               | JSONL 字符串 `collectJsonl`              | 结构化 event stream                          |
| Tool-call            | 依赖 JSON schema 间接约束                | 原生 tool-call / tool-result 事件           |
| Codex 全量 context   | 每次 prompt 塞全量                       | Thread 内增量，SDK 负责                       |
| 错误重试             | string match `"session" \| "already in use"` | 捕获具体 error 类型                         |

**Phase 0 待 spike 项**：Codex SDK 实际把 thread session 持久化到哪（`~/.codex/sessions/` ？进程内？），多 ufoo daemon 同跑是否会串 session——Phase 0 必须做一次最小 spike 得出结论并写进 §4.1 auth 小节，若确认共用同一份目录则必须加 profile 隔离。

#### 4.5.4 保留不变的部分

1. poll bus queue 主循环（`drainQueue` / `sleep(1000)`）
2. `createBusSender` / `createActivityStatePublisher`
3. heartbeat `updateHeartbeat`
4. subscriber 解析与 nickname 处理

这些是 ufoo 侧的契约，和 provider 无关，不动。

#### 4.5.5 Worker 侧 tool 注入

internal 模式下的 worker（Codex / Claude）可以直接通过 tool-call 调用 ufoo 协调能力，无需把请求转发回 controller。

注入时机：

1. `internalRunner` 启动 Thread 时，从共享 tool registry（§6）按 **Worker 权限**筛出可用工具集合。
2. 每次 `thread.runStreamed(prompt, { tools, toolExecutor })` 时把筛选后的工具注入。
3. Worker 的 tool-call 事件被 SDK / translator 捕获后，由 `toolExecutor` 在 **runner 进程内同步执行**，结果通过 tool-result 事件回填给 worker，不经 bus。

权限约束（详见 §6）：

1. Worker 只拿 Tier 0（读）+ Tier 1（协调）工具。
2. Worker 不拿 Tier 2（编排：`launch_agent` / `rename_agent` / `close_agent` / `manage_cron`）——避免 worker 自繁殖与资源失控；要扩容通过 `dispatch_message` 找 controller。
3. Worker 不拿执行类工具（shell / edit / file read）——这些由 SDK 自带原生能力覆盖，ufoo 不再复制一份。
4. **Worker 间接扩容是允许的协作模式**：worker 可通过 `dispatch_message` 向 controller 发送扩容请求（"请给我 launch 一个 codex 做 X"），controller 自行判断是否执行 `launch_agent`。这条路径是显式设计的，不是安全漏洞；但需要 controller 对扩容请求的 rate-limit 与频次观测（observability 字段 `controller.launch_from_worker_request`，连续 1 小时 > 5 次告警）。
5. **Tool handler 的 tier 校验层**：`ctx` 注入字段扩展为 `{ subscriber, caller_tier: "controller" | "worker", projectRoot, turn_id, tool_call_id, observability, redactor }`；每个 tool handler 自己按 `caller_tier` 做权限断言（Tier 2 工具收到 `worker` 立刻返回 structured error）。registry.js 在 export tool 时额外附 `allowed_tiers` 元数据，便于集中校验。

安全与审计：

1. Tool call 的入参、耗时、错误、关联的 `turn_id` + `tool_call_id` 全部走 §14 observability 通道；memory 写操作必须附带这两个字段以便事后溯源。
2. 写类工具调用前由 `toolExecutor` 做 subscriber 身份校验：
   - `dispatch_message` 的 `source` 字段必须等于 `ctx.subscriber`，不允许假冒他人发消息；`target` 必须是合法的 agent-id / nickname / `broadcast` 之一，不能投递到非 agent 队列
   - `ack_bus` 只能 ack `ctx.subscriber` 自己的队列（按队列 owner 校验，不只看 source agent）
   - memory `remember` 记录 `source: agent:<ctx.subscriber>` 仅用于溯源；`edit_memory` 与 `forget` 允许直接修改任意条目，冲突控制与审计详见 memory plan §6.4
3. Worker 调用失败时把结构化 error 回填，不终止 thread；连续 N 次同 tool 失败才触发 `close()`。

用户可见性与错误格式：

1. **Tool call 进度穿透**：activity state publisher（§4.5.4 保留不变）扩展发布 `tool_call_in_progress` / `tool_call_completed` 两类事件，包含 `tool_name` 与非敏感摘要，避免用户在 `ufoo status` / UI 侧看到 agent "卡死"假象。
2. **Tool call 失败的用户可见错误**：final reply 以结构化段落展示（"⚠️ `dispatch_message` failed: target not found"），不静默吞错；详细错误（堆栈、原始 provider error）只进 observability，不塞 reply。
3. **Loop 超预算 / 墙钟超时**：final reply 明确标注 "loop terminated: budget_exceeded / wall_timeout"，告诉用户哪一类 terminal reason。

## 5. 意图分流策略

`ufoo-agent` 先做意图分流，再决定是否进入 loop。

### 5.1 Fast path: 路由意图

适用场景：

1. “交给谁”
2. “继续哪个 agent”
3. “给 architect 发这个”
4. “需要新开一个 codex 吗”

行为：

1. 使用 router model
2. 可直接调用 `route_agent`
3. 一次返回 routing result

### 5.2 Loop path: 非纯路由意图

适用场景：

1. 需要先查看 bus/runtime/history 再判断
2. 需要 launch + dispatch + rename + cron 组合操作
3. 需要轻量 controller-side 探索

行为：

1. 使用 orchestration model
2. 进入受限 loop
3. 调用 controller tools
4. 最终返回 controller action 或 final reply

### 5.3 误分类兜底

Router 把本应进 loop 的请求当作 fast path 处理时的降级策略：

1. `route_agent` 返回 `confidence < 0.6` 或 `target == "unknown"` 时，runner 自动升级为 loop path，不向用户报错。
2. Fast path 返回结果后若 controller 执行 routing action 失败（target 不存在、dispatch 无法送达等），自动升级为 loop path 重跑一次。
3. 升级事件走 observability (`controller.fast_path_upgraded`)，连续 1 小时升级率 > 20% 时告警，提示 router prompt 或阈值需要调整。
4. 升级后 loop path 的输入包含 fast path 的原始判断与失败原因，作为 loop 的上下文 hint。

## 6. Tool Registry

ufoo 维护**单一共享 tool registry**，被 controller（`ufoo-agent`）与 internal 模式的 workers（Codex / Claude）共同消费。每次 `thread.runStreamed` 按调用者身份从 registry 筛出授权子集后注入。

### 6.1 三层权限模型

| Tier    | 工具                                                                                                      | Controller | Worker |
| ------- | --------------------------------------------------------------------------------------------------------- | :--------: | :----: |
| Tier 0 读 | `read_bus_summary` / `read_prompt_history` / `read_open_decisions` / `list_agents` / `read_project_registry` | ✅ | ✅ |
| Tier 1 协 | `dispatch_message` / `ack_bus` / `route_agent` / 六个 memory 工具（见 memory plan）                         | ✅ | ✅ |
| Tier 2 编 | `launch_agent` / `rename_agent` / `close_agent` / `manage_cron`                                           | ✅ | ❌ |

`post_decision` 不在当前 registry 中（见 §6.3）。

授权规则：

1. Controller 拿满 Tier 0-2，是唯一能扩容 / 关停 / 改 cron 的主体。
2. Worker 只拿 Tier 0-1，需要扩容通过 `dispatch_message` 请求 controller；避免 worker 自繁殖导致资源失控。
3. 两者都**不提供**执行类工具（shell / edit / file read / search）——Codex SDK 和 Claude SDK 已带原生等价能力，ufoo 不复制一份，防止语义打架。
4. `route_agent` 之所以给 worker，是让 worker 在需要向其他 agent 转交时自行判断目标；最终 dispatch 仍由 `dispatch_message` 完成。

### 6.2 工具说明

**Tier 0 — 读取**

1. `read_bus_summary` — bus / daemon 汇总状态、未读消息、pending reports
2. `read_prompt_history` — agent 近期 prompt history 摘要
3. `read_open_decisions` — 当前项目 open decisions 列表
4. `list_agents` — 在线 agent、nickname、状态、activity
5. `read_project_registry` — 跨项目 registry 读取

**Tier 1 — 协调**

1. `dispatch_message` — 向 target agent / nickname / broadcast 发消息，带 immediate / queued mode
2. `ack_bus` — 标记 bus 消息已处理；校验仅允许 ack 调用方 `ctx.subscriber` 自己的队列
3. `route_agent` — 输入用户请求 + 可选上下文，返回目标 agent / nickname / reason / confidence
4. Memory 工具（`remember` / `recall` / `search_memory` / `edit_memory` / `forget` / `search_history`）——详见 `docs/ufoo-shared-memory-plan.md`，独立 phase 上线

约束：共享上下文按 **read-first** 设计。`read_open_decisions` 是 decisions 的默认读入口；memory 上线后，prefix + `recall` / `search_memory` 组成默认读入口。不要把 decisions 或 memory 设计成 write-only sink。

**Tier 2 — 编排（仅 controller）**

1. `launch_agent` — 新起 codex / claude / ucode worker
2. `rename_agent` — 改 agent 的 nickname
3. `close_agent` — 关闭指定 agent session
4. `manage_cron` — 增 / 列 / 停定时任务

### 6.3 明确不做的工具

以下不进入 registry，防止 controller / ufoo 层越界：

1. `run_shell` / `bash` — 由 worker 的 SDK 原生能力覆盖
2. `read_file` / `edit_file` — 同上
3. `search_codebase` — 同上
4. `assistant_call` — 已完全废弃（见 Phase 4）
5. `post_decision` — 暂不实现。现有 `.ufoo/context/decisions/` 系统的写入习惯导致决策文件膨胀、信噪比低；等 tool-call 收敛且能做到"只记关键决策"的粒度再恢复。现阶段 agent 的决策轨迹通过读各自 claude / codex 历史回溯，`read_open_decisions`（Tier 0）仍提供对既有 decisions 的只读访问作为 legacy 数据源。

说明：`search_history`（memory 层提供，见 `docs/ufoo-shared-memory-plan.md`）不在本禁用清单——它不是对任意文件的读，是对 claude / codex session 记录的**结构化按需聚合**，职责独立于"读项目源码"。

如确需 controller 做轻量探索，必须显式通过 `dispatch_message` 下发给 coding worker，不在 controller 侧本地执行。

### 6.4 Tool schema 样板（Phase 0 产物）

所有工具使用统一 JSON Schema 描述，translator 层据此生成 Codex / Claude 的 tool definition。示例：

```json
{
  "name": "route_agent",
  "description": "Pick the best agent / nickname for the user request.",
  "input_schema": {
    "type": "object",
    "required": ["request"],
    "properties": {
      "request": {"type": "string"},
      "context_hint": {"type": "string"}
    }
  },
  "output_schema": {
    "type": "object",
    "required": ["target"],
    "properties": {
      "target": {"type": "string"},
      "nickname": {"type": "string"},
      "reason": {"type": "string"},
      "confidence": {"type": "number"}
    }
  }
}
```

Phase 0 至少固化三份样板 schema：`route_agent`、`dispatch_message`、`launch_agent`，作为翻译层验证用例。

## 7. 迁移策略

### 7.1 保留兼容层

迁移初期保留的代码路径：

1. 现有单轮 JSON router
2. `assistant_call` 处理路径
3. helper-agent 路径

保留策略：

1. 上述三条路径仅在 `legacy` 与 `shadow` 两档 flag 下可被触发。
2. 进入 `router-api` 档起不再被新请求调用。
3. Phase 4 统一**删除**全部代码，不保留长期 fallback。

### 7.2 分阶段上线

#### Phase 0: 设计与接口冻结

范围：

1. provider runtime interface
2. tool schema
3. loop state machine
4. feature flag
5. observability 字段清单
6. 凭据读取路径与隔离规则

产物：

1. 设计文档
2. 类型定义
3. 状态转换图
4. 三份 tool JSON schema 样板（`route_agent` / `dispatch_message` / `launch_agent`）
5. feature flag 名、默认值、回滚路径文档
6. observability event schema（每轮 model call / tool call 的字段约定）

#### Phase 1: Provider 层（分三小阶段）

Phase 1 拆成 1a / 1b，对应 Codex SDK 与 Claude API。两阶段完成即可让 `internalRunner` 的主流量切到新路径。`ucode` thread 化路径不纳入当前 v1 主线，移至文档后部独立议题。

##### Phase 1a: Codex SDK 接入

范围：

1. 引入 `@openai/codex-sdk` 依赖。
2. 实现 `CodexSdkThread`（§4.5.1）。
3. Codex SDK event → ufoo event translator（§4.2 表格第一行）。
4. 把 `internalRunner` 中 `provider === "codex-cli"` 分支切到 `CodexSdkThread`；legacy `runCliAgent` 作为 flag 控制的 fallback 保留。

验收：

1. Codex agent 在 SDK 路径下能正常响应 bus 消息，输出与 legacy 路径一致（shadow diff 通过）。
2. Thread 在 runner 生命周期内复用，连续 N 条消息只 spawn 一次底层 CLI。
3. `item.completed` / `turn.completed` 事件可被 translator 吞掉并产出标准 ufoo event。
4. SDK 子进程崩溃时 runner 能识别并重建 thread，不影响后续消息处理。

##### Phase 1b: Claude API provider + OAuth 桥接

风险最高，拆三个里程碑串行推进：

###### Phase 1b-i: OAuth token 读取与刷新

范围：

1. 实现 `ClaudeOauthTokenReader`：从 `~/.claude/`（或 profile 路径）读取 token；过期刷新走 atomic rename + flock。
2. 覆盖 token 格式版本嗅探，未识别版本显式报错。
3. `ANTHROPIC_API_KEY` 优先级与 OAuth token 的切换规则实现。

验收：

1. 各类 token 状态（新鲜 / 临近过期 / 已过期 / 损坏）单测覆盖。
2. 并发 refresh 在 `flock` 保护下不撞写，测试覆盖两进程同时刷新。
3. 无 token + 无 API key 场景抛出可识别错误。

###### Phase 1b-ii: ClaudeApiThread + translator

范围：

1. 引入 `@anthropic-ai/sdk` 依赖。
2. 实现 `ClaudeApiThread`（§4.5.1）——直连 Messages API，thread 状态由 ufoo 侧 `messages` 数组维护。
3. Claude HTTP SSE → ufoo event translator（§4.2 表格第二行）。

验收：

1. 发送 / 接收多轮消息正常，`tool_use` / `tool_result` block 正确归一化。
2. SSE 断开可自动重连一次，重连失败抛出可识别错误。
3. translator round-trip 单测通过。

###### Phase 1b-iii: 切换 runner claude 分支

范围：

1. 把 `internalRunner` 中 `provider === "claude-cli"` 分支切到 `ClaudeApiThread`；无 OAuth / 无 API key 时返回明确 direct credential error，不回退 CLI。
2. prompt caching 按 §9.3 三段接入。

验收：

1. Shadow 模式下 claude 输出与 legacy 路径一致。
2. direct credential error 场景生效，错误信息明确。
3. 首轮静态段 cache 命中率 ≥ 80%，可观测。

##### Phase 1 整体验收

在 1a + 1b 完成后补一轮整体检查：

1. Translator round-trip 等价性：`ufoo request -> provider request -> ufoo request` 关键字段（intent、tools、tool IDs、stop semantics）保持不变，允许 provider 规范化导致的非关键字段差异，两个 provider 均覆盖。
2. 长响应分片 / 多 tool-call 串联场景通过集成测试。
3. `internalRunner` 默认路径不再 spawn `runCliAgent` 子进程；legacy 仅在 flag 显式指定或 provider 不可用时触发。
4. Secret redactor 覆盖 OAuth token，确保不出现在日志 / bus / history。
5. 流式中断可自动重连一次；重连失败抛出可识别的错误类型，runner 能重建 thread。

#### Phase 2: Router fast path

范围：

1. 新增 router model config
2. 新增 `route_agent`
3. 用 API-backed provider 替换当前路由主路径

验收：

1. 纯路由请求不再依赖临时 CLI JSON router
2. 纯路由时延显著下降

#### Phase 3: Limited loop agent

范围：

1. 实现 `ufoo-agent` loop runtime
2. 接入最小 controller tools
3. 非纯路由请求可在 controller 内完成多步工作

验收：

1. 至少支持三类多步编排案例
2. loop 在最大轮数内稳定收敛

#### Phase 4: 删除 helper 与 assistant_call

范围：

1. 删除 `assistant_call` 处理路径与相关 prompt 片段。
2. 删除 helper-agent 的调用 / 启动 / 管理代码。
3. 清理 `ufoo-agent` 中 `assistant_call` / `dispatch` / `ops` 这一套 JSON schema 字段。
4. 清理 flag 取值中的 `loop-default` / `loop-only` 等过渡档。

验收：

1. 代码中不再存在 `assistant_call` / helper-agent 调用路径。
2. 现有端到端用例（§11）在 `loop` 档下全部通过，不依赖任何 legacy 或 helper。
3. Controller tool coverage 充分：跑一遍过去 30 天历史 `assistant_call` 请求样本，确认 100% 能被现 Tier 0-2 工具覆盖；若出现覆盖缺口，补 tool 后再删。

### 7.3 Feature flag 与 shadow mode

统一通过一个 flag 控制 controller 执行路径：

| Flag 值         | 行为                                                              | 默认阶段 |
| --------------- | ----------------------------------------------------------------- | -------- |
| `legacy`        | 单轮 JSON router，完全保持现状                                    | Phase 0  |
| `shadow`        | 主路径仍是 legacy，同时异步调一份新路径并记录 diff                | Phase 1  |
| `router-api`    | 纯路由请求走 API-backed fast path，其他仍 legacy                  | Phase 2  |
| `loop`          | 非纯路由进入受限 loop，纯路由仍 fast path（终态）                 | Phase 3+ |

Phase 4 删除 helper / `assistant_call` 代码后，flag 取值保持 `loop` 不变；这是终态，不再有后续过渡档。

规则：

1. Flag 可在用户 / 项目 / 进程三层覆盖，读取时由窄到宽。
2. 每一档都必须具备一键回滚到前一档的能力；回滚不要求重启 daemon。
3. **回滚粒度**：切档事件生效点是"下一条从 bus queue 取出的消息"，不影响当前正在 `runStreamed` 的 turn（避免消息处理一半被打断）。长 thread 内若 turn 跨越切档，该 turn 继续用切档前的路径跑完，下一条消息才用新路径。observability 事件 `controller.flag.transition` 附带 `applied_from_msg_id` 标注实际生效点。
4. `shadow` 模式下不得让新路径产生本地编排副作用（不 dispatch、不 launch、不写 bus queue、不改 controller state、不写 memory）；**但允许以下行为**：
   - 只读型上游 provider 调用（消耗真实 quota）
   - observability 事件写入（标注 `shadow_only: true`）
   - shadow diff 日志写入专属路径 `.ufoo/shadow/diff-*.jsonl`
5. **Shadow 双跑成本控制**：
   - 默认采样率 10%（非 100%），按请求哈希取模；紧急调查可临时调高到 100%
   - 单日 shadow 额外 token 预算上限：50k input + 10k output，超限自动降采样率
   - 如检测到上游 provider 返回 429 / rate-limit，shadow 路径立即熔断至下次 daemon 重启
   - 两周 OR 500 有效样本中较先到者，评审通过即升档
6. 每次切档在日志中写入一条结构化 `controller.flag.transition` 事件。

## 8. 模块拆分建议

建议新增模块：

### 8.1 `src/agents/providers/`

建议文件：

1. `index.js` — 对外导出 ThreadProvider 实现
2. `types.js` — `Thread` / `ThreadProvider` / `UfooEvent` 类型定义
3. `codexSdk.js` — `CodexSdkThread`，包 `@openai/codex-sdk`
4. `claudeApi.js` — `ClaudeApiThread`，直连 `@anthropic-ai/sdk`
5. `claudeOauth.js` — 从 `~/.claude/` 读取 / 刷新 OAuth token
6. `stream.js` — 流式事件归一化与重连
7. `translator.js` — ufoo ↔ provider 消息翻译（两 provider 分文件实现，统一接口）
8. `toolRepair.js` — tool-call 参数格式修复

职责：

1. 上游认证与请求构造（Claude 走 HTTP，Codex 走 SDK 管理的 CLI 子进程）
2. transport 抽象（HTTP/SSE for Claude；SDK event stream for Codex）
3. tool event normalization
4. Thread 生命周期管理

Secret redaction and shadow diff helpers now live separately in
`src/runtime/privacy/`.

### 8.2 `src/orchestration/controller/`

建议文件：

1. `loopRuntime.js`
2. `intentRouter.js`
3. `models.js`
4. `stopConditions.js`

职责：

1. loop state machine
2. routing fast path
3. model 选择与预算守护

### 8.3 `src/tools/` — 共享 tool registry

被 controller（`src/orchestration/controller/`）与 internal runner（`src/agents/internal/internalRunner.js`）共同消费，按调用者身份筛授权子集。

建议文件：

1. `registry.js` — 聚合导出 + Tier 元数据 + 按身份筛选器
2. `types.js` — `ToolDefinition` / `ToolContext` / `ToolResult` 类型
3. `tier0/` — 读类
   - `readBusSummary.js`
   - `readPromptHistory.js`
   - `readOpenDecisions.js`
   - `listAgents.js`
   - `readProjectRegistry.js`
4. `tier1/` — 协调类
   - `dispatchMessage.js`
   - `postDecision.js`
   - `ackBus.js`
   - `routeAgent.js`
5. `tier2/` — 编排类（仅 controller）
   - `launchAgent.js`
   - `renameAgent.js`
   - `closeAgent.js`
   - `manageCron.js`

每个工具导出：`{ name, tier, schema, handler(ctx, args) }`。`ctx` 由调用方（controller 或 runner）注入，包含 `subscriber`、`projectRoot`、observability sink、secret redactor。

## 9. 模型策略

建议把模型分成两档。

### 9.1 Router model

用途：

1. 低延迟 intent classification
2. routing-only 决策

特点：

1. 小模型
2. 快
3. 低成本

默认选型（Phase 2 上线时钉死，后续按实测调整）：

1. 首选 `claude-haiku-4-5`（Anthropic 最小档位，支持 tool-call）。
2. Codex 账号侧使用其最小档位 reasoning model。
3. Provider 调用失败时返回结构化错误，不把主路径回退到 legacy CLI JSON router。

### 9.2 Orchestration model

用途：

1. loop
2. 多步编排
3. 工具调用

特点：

1. 比 router model 更强
2. 支持稳定 tool-call

默认选型：

1. 首选 `claude-sonnet-4-6`，平衡 tool-call 稳定性与成本。
2. 复杂多步编排可按 flag 升级到 `claude-opus-4-7`；不默认开启。
3. Codex 侧使用对应的 reasoning 档位。

### 9.3 Prompt caching

为避免 loop 每轮重付全量 input token，默认启用 prompt caching，分**三段**：

1. **静态段（cache prefix，长 TTL）**：`system`、tool schema、project registry 快照、agent roster 快照——会话内几乎不变。
2. **半静态段（session-scoped）**：memory prefix（见 `docs/ufoo-shared-memory-plan.md` §7），仅包含 INDEX.md 生成的 `id + title + tags` 清单——在一次 agent 会话内不 recompute，会话间（runner 重启、thread 重建）重算。不与静态段合并，单独一层 cache segment，便于 memory 变化时只失效这一段。
3. **动态段**：本轮 user prompt、上一轮 tool result、以及所有 `recall` / `search_memory` / `search_history` 的返回 body——每轮必变，不进任何 cache 段。

规则：

1. Phase 0 产物须给出 cache prefix 分段规则与命中率目标：
   - 静态段首轮命中率 ≥ 80%
   - 半静态段**会话内**命中率 ≥ 95%
   - 动态段不设命中率目标，但记录每轮的 memory-related token 量
2. observability 必须**按段分别统计** cache hit / miss token 数：`cache_static_hit` / `cache_semistatic_hit` / `cache_semistatic_miss` / `dynamic_memory_tokens`，便于成本回归。
3. Memory 写操作（`remember` / `edit_memory` / `forget`）不强制使当前会话的半静态段失效；agent 主动调 `recall` 拿最新数据（`recall` 的 body 返回走动态段，不占 cache 名额）。
4. **Router fast path 不注入 memory prefix**——haiku 类小模型对 1500 tokens 的 prefix 相对成本高，且纯路由意图不需要 memory。Fast path 只注入静态段（system + tool schema 最小子集）；若 agent 确实需要 memory 再升级为 loop path 调 `recall`（接 §5.3 兜底）。

## 10. 风险与缓解

### 10.1 风险：直接搬运 CLIProxyAPI 过大

缓解：

1. 只抽协议核心
2. 本地重新定义 provider interface
3. 不引入其 server/management/watcher 体系

### 10.2 风险：loop 让 controller 变慢

缓解：

1. 路由意图走 fast path
2. loop 只处理非纯路由请求
3. 限制轮数

### 10.3 风险：tool-call 兼容性差

缓解：

1. 优先支持 Codex / Claude 两条主路径
2. 做 tool-call / tool-output 事件测试
3. 在 streaming 层保留 repair 机制

### 10.4 风险：helper / assistant_call 删除后存在 controller 覆盖缺口

缓解：

1. Phase 4 删除前强制跑历史 `assistant_call` 请求样本覆盖率检查（见 Phase 4 验收 3）；出现缺口先补 tool。
2. 删除窗口期内保留 `legacy` 档 flag 作为退路，一键回到 Phase 0 状态。
3. 删除 commit 单独拆出，便于快速 revert。

### 10.5 风险：loop + 全量 context 拼接导致 token 成本爆炸

缓解：

1. 启用 prompt caching（见 §9.3）。
2. 单 loop token 预算硬上限。
3. observability 持续监控 token per loop / cache hit，超阈值告警。

### 10.6 风险：loop 进行中用户再次输入，状态错乱

缓解：

1. 默认排队策略；显式 cancel 立即中止。
2. loop runtime 为每个 session 单并发，禁止同 session 多个 loop 并跑。
3. 崩溃恢复策略明确不跨进程持久化，避免脏 state。

### 10.7 风险：凭据泄露

缓解：

1. 凭据只读，禁止落盘第二份。
2. Secret redactor 在以下**三层切片**必须生效，漏过任一层视为 bug：
   - **Tool 入参 pre-call**：工具 handler 收到 args 之前
   - **Provider 响应 post-stream**：translator 归一化 event 之后、loop runtime 消费之前
   - **持久化 pre-write**：写入 log / bus queue / memory / history / metrics 任何磁盘 sink 之前
3. Redactor 规则集中在 `src/runtime/privacy/redactor.js`（或等价），被所有 sink 强制调用；不允许绕过。
4. 单元测试覆盖"含 token / refresh token / Authorization header 的 payload 不会出现在任何持久化通道"，每层切片单独断言。

### 10.8 风险：Claude Code OAuth token 格式随 upgrade 变动

缓解：

1. `ClaudeOauthTokenReader` 做版本嗅探，未识别版本立刻返回明确 direct credential error。
2. 集成测试固定已知 token schema 的 snapshot；CI 跑 npm 最新 `@anthropic-ai/claude-code` 的安装后 smoke check。
3. Token 读取失败要给出显式错误提示，引导用户重新登录或设置 `ANTHROPIC_API_KEY`。

### 10.9 风险：Codex direct-upstream 协议漂移

缓解：

1. Codex credential reader 明确识别 schema，未知 schema 直接报错，不静默降级。
2. `ufoo status` / chat `/status` 暴露本机凭证 preflight，便于用户在运行前发现 token/schema/expiry 问题。
3. 增加 real-world auth fixture 与 SSE response golden fixture，协议变更时优先在单测暴露。

### 10.10 风险：Codex SDK 版本漂移

缓解：

1. `package.json` 把 `@openai/codex-sdk` 版本 pin 到精确 patch 号，而非 `^` range；升级走独立 PR。
2. CI 运行一组 SDK smoke test：`thread.runStreamed` 至少 10 类 event 都能被 translator 吞掉；任何 event 名称变动或 schema 微调在 CI 层面挡住。
3. `@openai/codex-sdk` 的 release note 作为后续 ucode thread 化评估前的定期 review 项，半年至少一次。
4. Translator 层对未识别 event 类型默认做结构化 warn + passthrough（不抛错），避免一条新 event 把 thread 打挂。

### 10.11 风险：多 ufoo daemon 共享 `~/.claude/` OAuth token / `~/.codex/sessions/` session

缓解：

1. `ClaudeOauthTokenReader` 每次 tool call 前**重读磁盘**，不缓存 token 副本；token refresh 本身由 flock 串行化（§4.1）。
2. 多 daemon 在同一用户同时跑时可能出现"A 刷新了，B 内存里是旧 token"——接受这一点，通过重读磁盘消除时间窗。
3. Codex SDK session 持久化位置在 Phase 0 spike 中查证（§4.5.3 待 spike 项）；若确认是 `~/.codex/sessions/` 全局共享，Phase 1a 强制要求多 daemon 启用 profile 隔离（`CODEX_HOME` 或等价 env）。
4. 多 daemon 场景的集成测试：同一用户同时跑两个 ufoo daemon 指向不同项目，确认两边 token / session 不互踩。

## 11. 测试与验收

至少覆盖以下场景：

### 11.1 路由直达

输入：
- “把这个交给 architect”

验收：
- 一次返回目标 agent
- 不进入 loop

### 11.2 路由前探索

输入：
- “看下现在谁最适合接这个任务”

验收：
- 先读状态/历史
- 再返回目标 agent

### 11.3 多步编排

输入：
- “新开一个 codex，让它先调查，再把结果发给 architect”

验收：
- loop 内调用 `launch_agent`
- 调用 `dispatch_message`
- 返回最终结果

### 11.4 Provider 协议

验收：

1. Codex API-backed path 支持 tool-call
2. Claude API-backed path 支持 tool-call
3. tool IDs / tool outputs 在翻译后保持一致

### 11.5 单元 / 集成测试

至少覆盖：

1. Translator round-trip 等价性（见 §7.2 Phase 1 验收 5）。
   说明：此处“等价”按语义等价定义，不要求字节级或字段级完全一致。
2. Loop state machine 的状态转换：正常收敛 / 工具失败重试 / 超预算中止 / 用户 cancel / provider 断连。
3. Secret redactor：含 token 的 payload 不写进日志、bus、history、memory、audit.jsonl 任一 sink。
4. Feature flag 各档位切换行为，包括 shadow 模式"无副作用"断言——具体断言清单：
   - 本地 bus queue 不新增消息（比对前后 queue 长度与 inode 列表）
   - 不产生任何 `dispatch` / `launch` / `rename` / `cron` 类副作用（Tier 2 工具全部 mock）
   - 不写入 `.ufoo/memory/` 任何文件（只读挂载或 snapshot 比对）
   - shadow 专属 observability 事件带 `shadow_only: true` 标记，不污染主指标
   - 允许：provider quota 消耗、`shadow/diff-*.jsonl` 写入
5. 多 daemon 共享 `~/.claude/` / `~/.codex/sessions/` 的竞争场景集成测试（见 §10.11）。

### 11.6 Shadow 模式比对（按 Phase 分层）

shadow diff 指标随 Phase 推进而变化，不能用单一"routing 一致率"衡量所有阶段：

**Phase 1 shadow（provider 层）**

1. 比较同一 request 在 legacy vs API-backed 路径下的 **model 最终响应文本**与 **tool-call 序列**。
2. 文本一致率用 token 级 BLEU ≥ 0.85 或人工复盘判定。
3. tool-call 序列按 tool name 列表比较，一致率 ≥ 95%。
4. 不一致样本按周归类：模型随机性 / translator bug / prompt 差异，各自走专项处理。

**Phase 2 shadow（fast path）**

1. routing target 一致率 ≥ 95%。
2. routing 置信度分布基本重合（KS test p > 0.05）。
3. 误分类 case 走 §5.3 兜底升级后的最终 action 再比。

**Phase 3 shadow（loop path）**

Loop 多步编排不可能逐轮完全一致，采用**"编排等价"**定义：

1. **Final action 等价**：最终 dispatch/launch/reply 在语义上一致（target、message 主旨、ops 种类相同）。
2. **Tool set 等价**：两条 loop 调到的 tool 名集合相同（顺序可不同，重复次数可不同）。
3. **轮数相近**：两边 round count 差值 ≤ 2。
4. 以上三条同时满足记为"等价"，不要求逐轮 diff。
5. 样本量 N=100 个多步请求，等价率 ≥ 80% 才算通过；不等价样本走人工复盘。

**样本规模**：每个 Phase 独立计算，不复用 Phase 1 的样本。

## 12. Done 定义

以下条件同时满足时，视为本方案完成 v1：

1. `ufoo-agent` 默认走 API-backed provider 层，不再依赖临时 CLI JSON router 做主路由。
2. 纯路由请求能通过 router model 快速完成。
3. `ufoo-agent` 支持受限 tool-call loop。
4. 共享 tool registry（§6）上线，Tier 0-2 工具可用。
5. Internal 模式的 Codex / Claude worker 可直接调用 Tier 0-1 工具，无需绕 controller。
6. `assistant_call` 与 helper-agent 代码路径已完全删除。
7. 关键路由与编排用例通过端到端测试。
8. Feature flag 各档位具备一键回滚能力（`loop` 为终态档）。
9. Observability 指标（token / 轮数 / cache hit / tool call 分布）在 dashboard 可见。
10. Shadow 模式下新旧路由一致率 ≥ 95%。
11. CLI 模式（`uclaude` / `ucodex` PTY 路径）在重构前后行为一致，未受影响。

## 13. 建议的实施顺序

按优先级建议如下：

1. 先做 provider runtime 抽象与 Thread 接口（Phase 1a + 1b），不做 loop。
2. 搭起共享 tool registry（§6）基础设施，**Tier 0 读类工具 + `route_agent`（Tier 1 中 fast path 专用）一同上线**，为 Phase 2 铺路。
3. 切 routing fast path（Phase 2）。
4. 引入 limited loop（Phase 3），同步上 Tier 1 其余协调工具（`dispatch_message` / `ack_bus`）与 Tier 2 编排工具。
5. 给 internal 模式 worker 注入 Tier 0-1 工具，验证直调路径。
6. 批量删除 helper / `assistant_call`（Phase 4）。
7. 独立推进 memory 层（`docs/ufoo-shared-memory-plan.md`），不阻塞上述 Phase；接入 tool registry 时机见 memory plan §9。

原因：

1. 先拿到 provider + 快路由收益，同时 tool registry 为后面 loop 和 worker 直调打地基。
2. Loop 和 worker tool 注入复用同一份 registry，不重复造轮子。
3. 删除 helper 放在最后，既确保 controller 覆盖充分，又把破坏性变更集中在一次。
4. 避免"协议层、loop、tool registry、helper 下线"四件事同一批变更。

补充：当前 v1 主线的 provider 改造只包含 1a（Codex SDK）→ 1b（Claude API + OAuth 桥接）。Codex 的 direct-upstream bridge 与 `ucode` thread 化均不再计入本阶段顺序，移至 §17 后续独立议题。

## 14. Observability 与预算

所有 controller 执行路径都必须产出统一的结构化事件，供日志 / metrics / 回归分析使用。

### 14.1 每次 model call 事件字段

1. `request_id`、`session_id`、`flag`
2. `model`、`provider`
3. `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`
4. `latency_ms`、`first_token_ms`
5. `tool_call_count`、`stop_reason`
6. `error`（结构化错误类型，若有）

### 14.2 每次 tool call 事件字段

1. `tool_name`、`tool_call_id`
2. `duration_ms`、`result_size`
3. `retry_count`、`final_status`

### 14.3 Loop 级汇总事件

1. `rounds`、`terminal_reason`（`final_answer` / `budget_exceeded` / `tool_failure` / `user_cancel` / `provider_error`）
2. `total_tokens`、`total_latency_ms`
3. `fallback_used`（`none` / `assistant_call` / `legacy_router` / `helper_agent`）

### 14.4 预算与告警阈值

1. 单 loop token 预算：默认 40k input + 8k output，可按 flag 覆盖。
2. 单 loop 墙钟超时：默认 60s。
3. Router fast path 单次墙钟超时：默认 5s，超时返回 provider error 并升级到 controller 可处理的显式失败路径。
4. provider error 命中率连续 1 小时 > 10% 时告警。

### 14.5 写操作审计追踪

memory 等写类操作必须产出审计事件，可用于事后溯源。audit 字段随 **source 类型**分两种格式：

**Agent 触发（tool call 写入）**

1. 必填：`ts` / `tool_name` / `subscriber` / `turn_id` / `tool_call_id` / `caller_tier`
2. 选填（按上下文指针性质决定）：
   - `history_session_id` + `history_offset`（若写入基于 `search_history` 返回内容）
   - `upstream_message_id`（若来自 bus 消息触发）
   - `recall_ids`（若写入基于 `recall` 返回的其他 memory 条目）

**CLI 触发（用户直接录入）**

1. 必填：`ts` / `tool_name: "cli"` / `subscriber: "user"` / `cli_cmd`（完整命令行）
2. `turn_id` / `tool_call_id` 字段以 `null` 填充，reader 必须容忍。

**落盘规则**

1. 事件单独落盘到 `.ufoo/memory/audit.jsonl`，只追加不改写。
2. 每行附 `schema_version: "1.0"`（见 §15.1）。
3. CLI 提供 `ufoo memory audit <mem-id>` 反查一条 memory 的全部关联 audit 事件，自动处理两种格式的字段差异。

## 15. Schema 版本策略

本方案涉及多处 schema（tool 定义、memory frontmatter、provider event、bus message），需要统一的版本兼容策略，避免新旧共存期的意外 break。

### 15.1 版本标识

1. Tool definition：每个工具的 schema 附带 `schema_version: "1.0"`，runtime 注入 tool list 时带版本号。
2. Memory frontmatter：每条 entry 附 `schema_version`，reader 按版本分发 parser。
3. Audit 事件：`.ufoo/memory/audit.jsonl` 每行附 `schema_version`；两种 source 类型（agent / cli）字段集不同但版本号统一递进。
3. Provider event（translator 归一化后的 ufoo event）：event envelope 附 `schema_version`。
4. Bus message：保留现有格式，新增字段时走 additive change，旧字段不删。

### 15.2 Migration 规则

1. Minor bump（`1.0 → 1.1`）：仅限 additive，旧 reader 必须能正常读；不强制迁移存量数据。
2. Major bump（`1.x → 2.0`）：需要显式 migration 脚本；migration 完成前禁止关闭旧 reader 路径。
3. 任何 schema 变更必须同步更新 `docs/schema-changelog.md`（建议新建）。
4. 存量数据 migration 走 dry-run + 备份 + 原子切换三步，不允许 in-place 改写。

## 16. Owners 与里程碑（占位）

以下字段在 Phase 0 正式启动前填入：

1. 每个 Phase 的 owner / co-owner。
2. 预估开始与结束日期（ISO 格式）。
3. 依赖关系与阻塞项。
4. Phase 验收评审人。

占位的目的：避免 Phase 间无主导致排期漂移。Phase 0 kickoff 时若此节仍为空，视为阻塞项。

## 17. 后续独立议题（不纳入本方案）

1. **通过 MCP 向 CLI 模式（`uclaude` / `ucodex` PTY 路径）暴露 ufoo tools**。本方案只覆盖 internal 模式 worker 的 tool 注入；PTY 用户自己敲 `uclaude` 时 session 里没有 ufoo 工具，需要单独一份 MCP server 方案。建议 Phase 4 之后独立立项评估。
2. **Codex / Claude direct-upstream bridge 后续加固**。2026-04-26 已完成 Codex credential bridge、OAuth refresh、direct HTTP/SSE transport、状态 preflight，并把 ufoo-agent / internal Codex thread 默认切到 direct API。后续只保留增量加固项：
   - 补更多 real-world Codex auth fixture 与 401/429/5xx golden response fixtures。
   - 继续完善 request/response translator、model alias/mapping、usage/cache 指标映射。
   - 补充“请求期间没有触发 `codex` 子进程”的 smoke/observability 验收。
   - 若未来 provider 必须走 companion proxy，该 proxy 只能暴露普通 direct upstream endpoint，不能把 CLI spawn 重新暴露给 ufoo 主路径。
3. **ucode worker 的 ThreadProvider / SDK 化路径**。当前 v1 已完成 Codex/Claude 的 API-backed 主线；`ucode` 后续若接入，应作为独立 post-v1 项推进，目标是把现有 native runtime 整理为与 `CodexSdkThread` / `ClaudeApiThread` 同级的 `UcodeThread`，其下游 provider 可继续复用 `openai` / `anthropic` / custom-compatible API 配置。
4. **统一共享 memory 层**：将现有 `src/coordination/memory/` 骨架演进为跨 agent 的结构化持久记忆层，包含 `remember` / `recall` / `search_memory` 工具、按需索引 claude/codex 本地历史、与 ctx decisions 的补充关系。详见 `docs/ufoo-shared-memory-plan.md`。
