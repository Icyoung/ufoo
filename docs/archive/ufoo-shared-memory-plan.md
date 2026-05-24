# ufoo 共享 Memory 层方案（Plan）

Date: 2026-04-20
Status: implemented
Revision: rev. 4, 2026-04-26
Related:
- `docs/ufoo-agent-api-loop-plan.md` §17（本 plan 的出处条目）
- 现有骨架：`src/memory/index.js`

## 0. 实现状态（2026-04-26）

本 plan 的 v1 Done 条件已落地到当前代码：

1. `src/memory/` 已从 append-only 骨架替换为 `.ufoo/memory/` markdown entry 存储，包含 `INDEX.md`、`audit.jsonl`、`.id-counter`、`.lock`、`archive/`。
2. `ufoo memory add/list/show/edit/forget/rebuild-index/audit` 已上线；CLI 写入仅绕过低噪启发式，不绕过 secret 检测。
3. Tier 1 tool 已包含 `remember` / `recall` / `search_memory` / `search_history` / `edit_memory` / `forget`，controller 与 worker registry 均可见。
4. Agent 默认读面已上线：controller system prompt 与 worker prompt 都会注入 `## Project Memory` prefix；prefix 优先读 `INDEX.md`，并按半静态 cache key 复用，不因本轮写入立即失效。
5. `search_history` 已支持本地 Claude/Codex 历史 JSONL 懒加载、返回前 redaction、`from_history: true` 标记、默认最多 3 条且总文本 ≤ 2KB。
6. Anti-echo 已上线：`remember` / `edit_memory` 会拒绝与最近 `search_history` 返回内容高度重叠的正文，要求 agent 用自己的话提炼永久事实。
7. Audit 已记录 `schema_version`、`turn_id`、`tool_call_id`、`caller_tier`、`history_session_id`、`history_offset`、`recall_ids`，`search_history` 只写 query 与片段摘要，不写原文。
8. Observability hooks 已上线：prefix token cap / cache hit-miss metadata、dynamic memory token 统计、每 actor 写频次 summary（默认 > 5 次/小时 warning）。
9. Router fast path 仍不注入 memory prefix；memory prefix 只在 main/loop/worker 读路径注入。

仍未纳入 v1 的只有 §9.3 的可选 embedding 检索（M3），因为它在本 plan 中明确是可选后续项。

## 1. 背景

ufoo 当前在"跨 agent 持久信息"这件事上有三条重叠但孤立的机制：

1. **ctx decisions**（`.ufoo/context/decisions/`）——每轮 agent 会话几乎都会写入，信噪比低，已经沦为噪音。本方案不试图修复它，而是**暂时放弃把 decisions 当主干**；老数据保留为只读 legacy 源。
2. **Claude Code / Codex 本地历史**——`~/.claude/projects/<hash>/*.jsonl` / `~/.codex/sessions/*`，信息密度高但单 agent 视角；适合做"事后为什么做了这个决定"的追溯。
3. **`src/memory/`**——19 行骨架，无读 API、无调用方。

本 plan 把第三条长成**ufoo 的项目级永久事实存储**，服务于"所有 agent 共享一些真正应该永久保留的事实"这个目标。对 decisions 的替代 / 回归单独评估。

## 2. 目标

1. 提供一个**收敛、低噪、高信号**的共享 memory 层：只记"这个项目永久为真的事实"。
2. 把 memory 能力作为 Tier 1 tool 暴露（`remember` / `recall` / `search_memory` / `edit_memory` / `forget` / `search_history`），接入主 plan §6 Tool Registry。
3. 提供用户侧 CLI（`ufoo memory ...`），让用户能**直接**录入 / 查看 / 删除 memory，不依赖 agent 触发。
4. 支持按需检索 claude / codex 本地历史作为事后溯源证据源，**不做自动抽取**。
5. 与主 plan 的 prompt caching 分段（§9.3）兼容：memory 作为半静态段，会话内不 invalidate。
6. **memory 不是 write-only sink**：agent 默认能看见 active memory 的摘要，需要细节时能主动 `recall` / `search_memory`；不接受只给写入不给读取的上线形态。

## 3. 非目标

1. **不记录**：用户偏好、agent 反馈、项目当前状态、session 残渣、任何会过期 / 会改变的东西。这些要么属于 Claude Code / Codex 各自的 memory 系统、要么属于 CLAUDE.md / AGENTS.md。
2. 不替换 ctx decisions 的存储格式；现有 `.ufoo/context/decisions/` 作为只读 legacy 保留。
3. 不在 memory 之上叠 type / category / agent scope 这类维度——经验证明只会变成"什么都能记"。
4. 不自动从 claude / codex 历史抽取 memory（noise 过大，误报代价高）。
5. 不实现向量检索 / embedding（MVP 默认不做）。
6. 不引入外部数据库或网络服务。

## 4. 设计原则

### 4.1 什么是"项目永久事实"

判据由两条组成，**同时满足**才算符合：

1. **非人性（non-personal）**：事实关于**系统 / 组织 / 外部世界**，不涉及具体某人的偏好、风格、反馈。涉人一律走 CLAUDE.md / AGENTS.md。
2. **耐时性（time-invariant）**：事实不依赖"当前 session"、"当前 sprint"、"当前项目阶段"；可能随大型重构改变，但不会因下一次对话而失效。

典型例子（应该进 memory）：

1. **组织归属**："生产 Stripe 账号在 founder 名下，不是 company"——跨人跨时间都稳定
2. **外部系统约定**："DBA 每周二做 vacuum，不要在周二跑 heavy migration"——外部流程，非技术栈相关
3. **架构 invariant**："所有 user id 在系统内必须是 UUID v7"——跨实现语言 / 跨模块稳定
4. **外部账号 / 凭据位置约定**（不是 key 本身）："prod env vars 从 1Password vault `engineering/prod` 注入"——引用路径相对稳定
5. **不成文的业务约束**："免费用户每月最多 3 次导出，规则不在代码里而在合规文档"

反例（不该进 memory）：

| 反例 | 应去往 |
| ---- | ------ |
| "用户今天让我跑 lint" | 不记录 |
| "项目当前在重构 auth 模块" | 不记录（会变） |
| "用户喜欢简短回复" | CLAUDE.md（涉人） |
| "我偏好用 TypeScript 写脚本" | CLAUDE.md（涉人） |
| "团队约定每条 commit 要带 issue id" | CLAUDE.md / AGENTS.md（涉人规范） |
| "这次决定使用 tool-call loop" | 不记录（决策痕迹，等 `post_decision` 回归再说） |
| "codex-22 在 build-lane 组" | 不记录（会变的编排状态） |
| "当前选用 Postgres" | 源码 / 文档已体现，不需二次记录 |

**边界澄清（γ1）**：

1. 涉及**人**（用户本人、特定 agent 实例、团队成员）的偏好 / 风格 / 反馈 → **CLAUDE.md / AGENTS.md**
2. 涉及**系统**（架构、组织、外部服务、流程约定）的事实 → **memory**
3. 判断不准时，优先走 CLAUDE.md；memory 宁缺勿滥

### 4.2 写入门槛

1. **CLI 写入（用户主动触发）**：跳过启发式校验（禁用模板、长度下限），仅过 secret redactor；用户自己负责内容质量。
2. **Tool call 写入（agent 主动触发）**：handler 做三道启发式校验：
   - `body` 长度：20–2000 字符（英文约 4–400 词）；过短信息量不足，过长应拆分或不该进 memory
   - 禁用模板：出现 `just decided` / `just now` / `today` / `current` / `现在` / `今天` / `本月` / `最近` / `正在` / `刚才` / `本 sprint` / `本阶段` 等时间指向性词时直接拒绝
   - Secret redactor（见主 plan §10.7 三层切片 pre-write 层）
3. 启发式校验是**最低门槛而非充分条件**；真正的质量控制靠：
   - audit.jsonl 可追溯每次写入 / 修改 / 归档
   - observability 对单 subscriber 写入频次告警（默认 > 5 次/小时）
   - 人工每月 review 一次 INDEX.md

### 4.3 与 decisions / 本地历史的关系

| 维度 | memory | decisions（legacy） | claude/codex 本地历史 |
| ---- | ------ | ------------------- | ---------------------- |
| 生命周期 | 永久事实 | 某次会话的决策快照 | 每次 session 的原始流 |
| 粒度 | 短条目 | 一文件一决定 | 按消息 / tool call |
| 本 plan 角色 | **主存** | 只读 legacy | 只读证据源（按需拉取） |

### 4.4 读取优先（read-first）

共享上下文如果只有写入、没有稳定读取，会立刻退化成噪声仓库。因此 memory 必须按**读取优先**设计：

1. agent 默认应看见 active memory 的摘要，而不是靠“猜这个项目也许有 memory”。
2. 细节读取（`recall` / `search_memory`）必须与 agent 侧写入能力同阶段成为一等能力。
3. 不允许出现 agent 能 `remember` / `edit_memory`，却没有任何默认读面或主动读工具的形态。
4. 写入只是更新共享事实；真正让共享事实生效的是后续 agent 能读到它。

## 5. 数据模型

极简。一条 memory = 一个 markdown 文件：

```markdown
---
id: mem-0001
tags: [infra, secrets]
source: user | agent:<subscriber>
created_at: 2026-04-20T12:34:56Z
updated_at: 2026-04-20T12:34:56Z
status: active | archived
schema_version: "1.0"
---

# {{一行标题 / 描述}}

{{正文 — markdown，可长可短，但鼓励短而精确}}
```

### 5.1 字段

- `id` — 单调递增（`mem-0001`、`mem-0002`），分配由 `IDAllocator` 做 atomic counter 落盘。
- `tags` — 可选，自由字符串，用于按 topic 检索。
- `source` — 谁首次写入。`user` / `agent:<subscriber>`。仅用于溯源，不参与权限判定。
- `status` — `active` 或 `archived`。归档即"软删"，物理文件保留。
- `schema_version` — 用于 §主 plan 15 的版本迁移策略。

**不包含** `type` / `scope` / `related_decisions` / `supersedes`——由经验证明它们只会引发混乱。

### 5.2 存储路径

只有一个 scope：**当前 `projectRoot` 级**。

```
<project>/.ufoo/memory/
├── INDEX.md
├── audit.jsonl            # 写操作审计日志（见主 plan §14.5）
├── .lock                  # 并发写文件锁
├── .id-counter            # 单调 id 分配
├── mem-0001.md
├── mem-0002.md
├── archive/
│   └── mem-0003.md        # status=archived 归档
```

**不提供** user 级 / agent 级 scope。跨项目的知识要么是用户偏好（走 CLAUDE.md），要么是新项目里重新录入的事实。
共享 memory 默认允许直接修改，不额外引入 `pending/` 审批层；污染控制依赖 audit、告警与人工 review。

### 5.3 INDEX.md

每条 memory 在 INDEX.md 里占一行，且 **INDEX 的物理顺序本身就是 `updated_at DESC`**：

```
- mem-0001 [infra,secrets] 线上 Stripe key 归属 founder 账号
- mem-0002 [arch] 所有 user id 使用 UUID v7
```

读取优先扫 INDEX.md 拿 id / title / tags，按需打开详细 entry。Prefix 构建直接信任 INDEX 当前顺序，不再为排序额外扫全量 entry。INDEX 损坏或落后时可用 entries 目录扫描重建（`ufoo memory rebuild-index`）。

## 6. Tool 设计

全部 Tier 1（见主 plan §6.1），controller 与 worker 均可调用。

### 6.1 `remember`

写一条新 memory。

```json
{
  "name": "remember",
  "description": "Record a permanent project fact. Only use for facts that will remain true long-term and are not available from CLAUDE.md or source code. Do not record session state, user preferences, or short-term tasks.",
  "input_schema": {
    "type": "object",
    "required": ["title", "body"],
    "properties": {
      "title": {"type": "string", "maxLength": 150},
      "body": {"type": "string", "minLength": 20},
      "tags": {"type": "array", "items": {"type": "string"}}
    }
  }
}
```

handler 拒绝写入的情况（详见 §4.2 写入门槛）：

1. `body` 长度超出 20–2000 字符范围
2. `title` 或 `body` 出现禁用模板词（"just decided" / "just now" / "today" / "current" / "今天" / "现在" / "本月" / "最近" / "正在" / "刚才" / "本 sprint" / "本阶段" 等时间指向性措辞）
3. `body` 中检测到疑似 secret（redactor 命中，见主 plan §10.7）
4. 注：CLI 触发的写入跳过 1 / 2 两项，仅过 3（secret 检测不可绕过）

### 6.2 `recall`

按 id 或 tags 精确检索。

```json
{
  "name": "recall",
  "input_schema": {
    "type": "object",
    "properties": {
      "id": {"type": "string"},
      "tags": {"type": "array"},
      "limit": {"type": "integer", "default": 10}
    }
  }
}
```

### 6.3 `search_memory`

全文近似搜索。MVP 走 substring + token 匹配，无 embedding。

```json
{
  "name": "search_memory",
  "input_schema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": {"type": "string"},
      "limit": {"type": "integer", "default": 5}
    }
  }
}
```

### 6.4 `edit_memory` 与 `forget`（共享直接修改模型）

Memory 是项目级共享事实层，默认假设**任何 agent / 用户都可以直接修改或归档任意条目**。`source` 只记录首写来源，不做鉴权。防污染依赖 audit、频次告警和人工 review，而不是基于作者身份的锁定或 proposal 审批。

#### 6.4.1 `edit_memory`

对任意现有 memory 条目直接修改。

```json
{
  "name": "edit_memory",
  "input_schema": {
    "type": "object",
    "required": ["id"],
    "properties": {
      "id": {"type": "string"},
      "title": {"type": "string", "maxLength": 150},
      "body": {"type": "string", "minLength": 20},
      "tags": {"type": "array", "items": {"type": "string"}},
      "expected_updated_at": {"type": "string"}
    }
  }
}
```

行为：

1. `id` 必填；`title` / `body` / `tags` 至少提供一个。
2. 允许修改任意条目，不检查 `source` 与调用者身份是否匹配。
3. 每次修改同步更新 `updated_at`，重写 entry，并把修改前后的摘要写入 audit.jsonl。
4. 若提供 `expected_updated_at` 且与当前条目不一致，返回 structured conflict error，避免基于陈旧视图覆盖他人刚写入的内容。
5. 所有 mutation 仍通过 `.lock` 串行化。

#### 6.4.2 `forget`

对任意现有 memory 条目直接归档。

```json
{
  "name": "forget",
  "input_schema": {
    "type": "object",
    "required": ["id"],
    "properties": {"id": {"type": "string"}}
  }
}
```

行为：

1. 任意调用方均可归档任意条目。
2. 归档时更新 `updated_at`，移动到 `archive/`，并写入 audit.jsonl。
3. 不做硬删除；恢复能力不进 MVP，必要时用户可手动恢复或后续补 `unarchive`。

### 6.5 `search_history`

按需拉取 claude / codex 本地 session 历史片段，用作事后溯源证据。

```json
{
  "name": "search_history",
  "input_schema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": {"type": "string"},
      "agent": {"type": "string"},
      "session_id": {"type": "string"},
      "limit": {"type": "integer", "default": 3}
    }
  }
}
```

返回片段 schema：`{ source, session_id, ts, role, text, tool_name? }`。

**安全约束**（必须满足）：

1. 返回前由 secret redactor（主 plan §10.7）过滤；不允许把原始 token / API key 片段返回给调用方。
2. handler 在 response 中附结构化标记 `from_history: true`，loop runtime 与 CLI 都应展示该标记。
3. **禁止 `search_history` 返回的片段被原文 pipe 给 `remember` 或 `edit_memory`**：写 handler 若检测到 body 高度重叠 search_history 最近返回内容（基于字符匹配阈值），拒绝并提示"请用你自己的话转述关键事实"。
4. 默认最大 `limit=3`，最大返回文本 ≤ 2KB。

职责边界：`search_history` 不是 `read_file` 或 `search_codebase` 的替代——它只读 claude / codex session 记录（ufoo 知道这些文件的路径和格式），不读项目源码、不读任意文件。主 plan §6.3 "明确不做的工具" 对此有说明。

## 7. 系统 prompt 自动注入

每次 `thread.runStreamed` 启动前，runner / controller 根据当前项目拼出 memory prefix 注入到 system prompt 中。

### 7.1 Prefix 构建

1. 读 INDEX.md 取所有 `status=active` 条目的 `id + title + tags`
2. 直接按 INDEX 当前顺序输出（INDEX 由写路径维护为 `updated_at DESC`）
3. 组装为单段 markdown：

```
## Project Memory

- mem-0001 [infra,secrets] 线上 Stripe key 归属 founder 账号
- mem-0002 [arch] 所有 user id 使用 UUID v7
...
```

4. agent 需要细节自己调 `recall` / `search_memory`

这不是优化项，而是 memory 生效的**基础读路径**。没有 prefix + `recall` / `search_memory` 的组合，agent 侧 memory 只能算写库，不算共享上下文。

### 7.2 Cache 归属与 Router fast path 例外

按主 plan §9.3 规则，memory prefix 属于**半静态段（session-scoped）**：

1. 在一次 agent 会话内（同一 thread 生命周期内）不 recompute，保证 cache 命中。
2. 会话间（runner 重启、thread 重建）重算。
3. `remember` / `edit_memory` / `forget` 写操作**不立即 invalidate** 当前会话的 cache；写入只更新 INDEX 与文件，下一个会话自然看到新数据。
4. 如果某轮 agent 确实需要读最新 memory，主动调 `recall` 即可。`recall` 返回的 body 走**动态段**（见主 plan §9.3），每轮 token 成本实付，不占 cache 指标。
5. **Router fast path 不注入 memory prefix**（主 plan §9.3 规则 4）：haiku 类小模型对 1500 tokens prefix 成本占比过高，且纯路由意图不需要 memory。Fast path 仅注入最小静态段。

### 7.3 容量约束

1. Prefix 默认上限 ≤ 1500 tokens；超过时按 `updated_at DESC` 截断，仅保留最近 N 条。
2. 截断事件走 observability，长时间超限提示用户手动 `forget` 过期条目。

## 8. CLI 设计（用户侧入口）

新增 `ufoo memory` 子命令，让用户能直接操作，不依赖 agent。

### 8.1 基础 CRUD

```
ufoo memory add "线上 Stripe key 归属 founder 账号" \
    --tags infra,secrets \
    [--body-file path/to/body.md]

ufoo memory list [--tag infra] [--all]    # --all 包含 archived
ufoo memory show mem-0001
ufoo memory edit mem-0001                 # 调起 $EDITOR（用户直接编辑）
ufoo memory forget mem-0001               # 用户直接归档任意条目
ufoo memory rebuild-index
ufoo memory audit mem-0001                # 展示所有写操作溯源（§主 plan 14.5）
```

### 8.2 用户手动触发 agent 写入

用户也可以让 agent 帮忙写 memory，典型场景：

- "把刚才聊的 X 记到 memory 里" → agent 调 `remember`
- "把 mem-0001 里的表述改成 Y" → agent 调 `edit_memory`
- "这个事实永久记录，tag infra" → agent 调 `remember({tags: ["infra"]})`

CLI 不是唯一入口，但是**权威入口**——CLI 写入时 handler 跳过启发式校验（禁用模板、长度下限），仅过 secret redactor；用户自己负责内容质量。

## 9. 分阶段上线

### Phase 依赖与时序（钉一个权威版本）

memory 工作**不阻塞**主 plan Phase 0 / 1a / 1b / 2；M0（CRUD + CLI）可与主 plan 任意阶段并行推进，上线后用户可立即用 CLI 录入 memory。

但 M1（tool 接入 + prompt 注入）**必须等**主 plan **Phase 3 上线之后**：

1. 依赖 Tool Registry 基础设施（Phase 2 建成）。
2. 依赖 ThreadProvider 在 controller 与 worker 两侧都就绪（Phase 1a + 1b + Phase 3 loop runtime）。
3. Prompt 注入依赖 §9.3 半静态 cache 段分段规则生效（Phase 1 做好）。

主 plan §13 "建议的实施顺序"第 7 条"memory 独立推进不阻塞"指的是 **M0 阶段**；M1 / M2 的接入时机以本节为准。

### 推荐实施拆分（修订版）

为了降低一次性重写风险，建议按以下 slice 落地：

1. **Slice A: store 骨架替换**：把现有 `memory.jsonl append-only` 骨架替换为 entry 文件模型，先做 frontmatter 读写、路径管理、`.lock`、`.id-counter`、INDEX 重建。
2. **Slice B: mutation + audit**：补 `add / get / list / update / archive / rebuildIndex / audit`，把所有写路径统一串到 audit.jsonl。
3. **Slice C: CLI**：上线 `ufoo memory add/list/show/edit/forget/rebuild-index/audit`；先不接 agent tool。
4. **Slice D: core tools**：接入 `remember / recall / search_memory / edit_memory / forget` 五个核心工具，打通 controller / worker 两侧。
5. **Slice E: prompt prefix**：把 INDEX 注入半静态 cache 段，并补 observability 指标。
6. **Slice F: `search_history`**：最后接本地历史读取、redactor、anti-echo；与核心 memory CRUD 解耦。

约束：**不要把 Slice D 只做成写工具接线。** 如果 `remember` / `edit_memory` 对 agent 可用，则 `recall` / `search_memory` 和至少一个默认读面（prefix）也必须可用。

### Phase M0: 基础 CRUD + CLI

1. 扩 `src/memory/` 为完整模块：`MemoryStore` 提供 `add / list / get / update / archive / rebuildIndex / readAudit`。
2. `IDAllocator` 走原子计数器（写 `.id-counter.tmp` + rename）+ flock。
3. INDEX.md 自动维护（每次写操作同步更新）。
4. `ufoo memory` CLI 全部子命令上线（`add / list / show / edit / forget / rebuild-index / audit`）。
5. Audit.jsonl 的 CLI 触发格式（主 plan §14.5 "CLI 触发"分支）上线；agent 触发字段暂时 `null` 填充，待 M1 填充。
6. 单元测试覆盖并发写 / INDEX 损坏恢复 / atomic rename / 归档恢复场景。

M0 完成即可让用户通过 CLI 录入 memory；agent 暂不感知。

### Phase M1: Tool 接入 + Prompt 注入

**依赖主 plan Phase 3 完成**。

1. 实现五个核心 tool（`remember` / `recall` / `search_memory` / `edit_memory` / `forget`）并注册到 Tool Registry Tier 1；`search_history` 可推迟到 M2。
2. Controller 与 worker 同时开放调用；`ctx` 注入 `caller_tier` 用于 handler 鉴权（主 plan §4.5.5 权限约束 5）。
3. 实现 prompt prefix 注入（§7），接入主 plan §9.3 半静态段。
4. Audit.jsonl 的 agent 触发字段（`turn_id` / `tool_call_id` / `caller_tier` / 上下文指针）按主 plan §14.5 填充。
5. 启发式校验（§4.2 禁用模板词 + body 长度范围）与 secret redactor 全量接入；`edit_memory` 支持 `expected_updated_at` 冲突检测。
6. `remember` / `edit_memory` 不得在缺少 `recall` / `search_memory` / prefix 读路径时单独对 agent 开放；write-only rollout 视为未完成。

### Phase M2: 历史检索（`search_history`）

1. 实现 claude / codex 本地历史索引读取；格式差异在 memory 模块内部吸收。
2. 按需懒加载，不预建索引。
3. Secret redactor（主 plan §10.7 三层切片里的 pre-write 层）+ anti-echo 校验（§6.5 安全约束 3）。

可独立于 M1 推进，也可合并。若合并，建议在 M1 完成后 2-4 周再上 M2，让 `remember` / `recall` 在无历史检索的情况下先跑稳。

### Phase M3（可选）: embedding 检索

仅当 MVP 阶段出现"substring 匹配不够用"的真实案例才做。默认不进排期。

## 10. 风险与缓解

### 10.1 风险：agent 滥写导致 memory 退化为 decisions 的翻版

缓解：

1. §6.1 的写入门槛（body 长度、禁用模板、secret 检测）。
2. 每周 / 每月人工审阅 INDEX.md，手动 `forget` 明显噪声。
3. Observability 统计每个 subscriber 的 `remember` 频次，异常值告警。
4. 真的压不住时 fallback：关闭 agent 侧 `remember` 权限，只保留 CLI 入口。

### 10.2 风险：并发写 INDEX / 撞 id

缓解：

1. `.lock` 文件 + flock 串行化所有写操作。
2. `IDAllocator` 用 atomic rename 的计数器文件，任何 reader 读到半写状态视为 0 并重试。
3. 操作日志（audit.jsonl）append-only，足以事后重建状态。

### 10.3 风险：INDEX.md 损坏或与 entries 不一致

缓解：

1. `ufoo memory rebuild-index` 扫目录重建，手动触发。
2. 每次读 INDEX 时做一次轻量一致性检查（文件数对得上），不匹配打告警。
3. INDEX 是 derived view，权威源是 `mem-*.md` 文件本身，丢了 INDEX 不丢数据。

### 10.4 风险：`search_history` 泄露敏感内容

缓解：

1. 见 §6.5 安全约束三条：redactor、`from_history` 标记、禁止 pipe 给 `remember` / `edit_memory`。
2. 默认 `limit=3` 和 ≤ 2KB 总长度强制执行。
3. audit.jsonl 记录 `search_history` 的 query 与返回片段摘要（不含原文），用于事后回放。

### 10.5 风险：prompt 注入上限压缩后 agent 看不到关键条目

缓解：

1. 截断策略按 `updated_at DESC` 保最新 N 条；agent 可主动 `recall` 取全量。
2. 用户可通过 CLI 对关键条目 `edit` 刷新 `updated_at` 以"置顶"。
3. 超限 observability 告警，提示用户清理。

### 10.6 风险：secret 写入 memory

缓解：

1. `remember` 入参过 redactor（主 plan §10.7 规则集）。
2. 文档里明确禁止保存 token / API key / 凭据；CLI `add` 时若命中 redactor 规则直接拒绝并提示。
3. 单元测试覆盖"含 token 的 body 不会落盘"。

### 10.7 风险：共享直接编辑导致误覆盖

缓解：

1. 所有 mutation 通过 `.lock` 串行化，避免物理层面的并发写坏文件。
2. `edit_memory` 支持 `expected_updated_at` 冲突检测，避免陈旧视图直接覆盖新内容。
3. audit.jsonl 记录修改前后的摘要与调用者，出错后可回溯和人工修正。
4. CLI `edit` 默认应把读到的 `updated_at` 回传给 update path，保存时若冲突则让用户重试。

### 10.8 风险：共享直接编辑导致 churn / 低质量改写

缓解：

1. `remember` 与 `edit_memory` 共用启发式校验与 secret redactor，避免低质量文本直接落盘。
2. Observability 同时统计 `remember` 与 `edit_memory` 频次；单 subscriber 异常高频时告警。
3. 每周 / 每月人工审阅 INDEX.md，必要时直接 `forget` 或重写条目。
4. 真的压不住时，fallback 为关闭 agent 侧写权限，只保留 CLI 写入口。

## 11. Done 定义

v1 完成条件：

1. `src/memory/` 提供 CRUD + archive + rebuild-index + audit API，测试覆盖并发 / 损坏恢复 / 冲突检测。
2. `ufoo memory` CLI 子命令全部可用（add / list / show / edit / forget / rebuild-index / audit）。
3. 六个 memory tool（`remember` / `recall` / `search_memory` / `edit_memory` / `forget` / `search_history`）纳入 Tool Registry Tier 1，controller / worker 两侧均可调用，handler 按 `caller_tier` 校验权限。
4. System prompt 注入逻辑在 loop 与 worker thread 两处均生效；prefix cache 按主 plan §9.3 半静态段命中；router fast path 不注入 memory prefix。
5. `search_history` 支持 claude + codex 两来源，secret redactor 与 anti-echo 校验全部生效，并阻止原文直接写回 memory。
6. Audit log 可追溯每条 memory 的写入轨迹（关联 `turn_id` + `tool_call_id` + 历史证据指针）。
7. 文档：本 plan + CLI how-to + 与 decisions 关系说明写入 AGENTS.md / CLAUDE.md。
8. 写操作 schema 带 `schema_version`，与主 plan §15 版本策略兼容。
9. agent 侧至少存在一个默认 memory 读面（prefix）和两个主动读工具（`recall` / `search_memory`）；write-only memory rollout 不算 done。

## 12. 开放问题（留给后续对话）

1. `edit_memory` 的 `expected_updated_at` 在 agent path 上应当是可选还是默认必填？MVP 倾向可选，CLI path 默认带上。
2. 同一项目多 git worktree / 多 branch 暂不 special-case：每个 `projectRoot` 使用自己的 `.ufoo/memory/`；如果后续确实要共享，再单独设计 shared-root mode。
3. 回归 `post_decision`（关键决策）时，decisions 存储是沿用现有 `.ufoo/context/decisions/` 还是合入 memory 层？留到时间点到了再决定。
4. 是否需要 export / import（比如把 memory 打包分享给同项目新成员）？目前倾向不做，先把单项目本地能力跑稳。
