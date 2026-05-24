# Nickname Scoping Plan

Status: implemented

## Implementation Audit (2026-04-26)

Most of the nickname split has landed. Bus entries can store both `nickname`
and `scoped_nickname`; resolution accepts raw and scoped nicknames; daemon,
status, and chat display paths use helpers such as `resolveDisplayNickname` and
`resolveScopedNickname`; tests cover scoped nickname generation and lookup.

Group runtime terminology has been normalized: new runtime state writes
`scoped_nickname` for the project-scoped control-plane name. `runtime_nickname`
is no longer written by the group launcher and remains only as a legacy read
fallback for older runtime files.

## Background

`ufoo` 目前把“给人/模型看的名字”和“给控制面做唯一性隔离的名字”混在同一个 `nickname` 字段里。

当前行为大致是：

- group 模板使用原始 nickname，例如 `architect / builder / reviewer`
- daemon launch / rename 时会把 nickname 经过项目级前缀处理，变成 `neptune-builder`
- bus / daemon / chat 展示层大多直接读取 `meta.nickname`
- AI prompt 和 group bootstrap 也会间接受到这个混合后的值

这会带来几个问题：

- 前端展示变脏，用户看到的是 `neptune-builder`，而不是 `builder`
- group 模板和 runtime/bus 状态语义不一致
- AI prompt 里混入项目隔离前缀，增加无意义噪声
- nickname 恢复、重命名、跨项目唯一性逻辑越来越绕

## Goal

正式拆分 nickname 语义：

- `nickname`
  - 原始昵称
  - 给用户和模型看的名字
  - 例：`builder`
- `scoped_nickname`
  - 项目隔离后的运行昵称
  - 给 bus / daemon / 控制面做唯一性约束
  - 例：`neptune-builder`
- `subscriber_id`
  - 最终内部实体标识
  - 例：`claude-code:62d8de3f`

## Design

### 1. Data model

Bus agent entry 目标形态：

```json
{
  "agent_type": "claude-code",
  "nickname": "builder",
  "scoped_nickname": "neptune-builder",
  "status": "active"
}
```

约束：

- `nickname` 用于显示、prompt 注入、group 角色表达
- `scoped_nickname` 用于项目内外冲突避免、命令解析、底层调度
- `subscriber_id` 仍然是最终唯一实体标识

### 2. Auto nickname chain

当前默认名 `claude-1 / codex-1 / ucode-1` 来自 bus join 阶段。

保留这条链，但拆成双字段：

- 无显式昵称时：
  - `nickname = claude-1`
  - `scoped_nickname = neptune-claude-1`
- 有显式 group/template 昵称时：
  - `nickname = builder`
  - `scoped_nickname = neptune-builder`

### 3. Prompt / bootstrap semantics

prompt 一律使用原始 `nickname`，不使用 `scoped_nickname`。

原因：

- `builder / reviewer / architect` 有明确角色语义
- `neptune-builder` 只是控制面隔离值，对模型没有必要
- 避免 group bootstrap、route prompt、controller prompt 被项目名前缀污染

规则：

- AI prompt / bootstrap / routing context / group context：
  - 使用 `nickname`
- bus dispatch / exact routing / uniqueness / internal resolution：
  - 使用 `scoped_nickname` 或 `subscriber_id`

### 4. Command resolution

命令层应同时支持 3 种输入：

1. `subscriber_id`
2. 原始 `nickname`
3. `scoped_nickname`

例如这些都应解析到同一个 agent：

- `builder`
- `neptune-builder`
- `claude-code:62d8de3f`

## Impacted Areas

### Bus layer

需要改：

- `src/bus/subscriber.js`
- `src/bus/nickname.js`

职责：

- join 时同时写入 `nickname` 和 `scoped_nickname`
- auto nickname 生成后再派生 scoped 值
- `resolveNickname()` 同时支持 `nickname` 和 `scoped_nickname`
- `nicknameExists()` 的冲突判断以 `scoped_nickname` 为准

### Daemon layer

需要改：

- `src/daemon/index.js`
- `src/daemon/ops.js`
- `src/daemon/nicknameScope.js`

职责：

- launch/rename 时保留原始 nickname
- scoped 值单独存入 `scoped_nickname`
- 恢复、重命名、冲突清理按 `scoped_nickname` 工作
- 对外响应中同时返回：
  - `nickname`
  - `scoped_nickname`

### Group layer

需要改：

- `src/group/*`
- runtime group state 序列化

建议统一：

- group template 中继续保留原始 `nickname`
- runtime state 中把当前 `runtime_nickname` 语义统一迁移为 `scoped_nickname`

目标形态：

- `nickname = builder`
- `scoped_nickname = neptune-builder`

### Chat / UI layer

需要改：

- `src/chat/agentDirectory.js`
- `src/chat/index.js`
- `src/chat/daemonMessageRouter.js`
- 其他直接显示 `meta.nickname` 的位置

显示规则：

- 默认展示 `nickname`
- 若缺失，再 fallback `scoped_nickname`
- 再缺失才 fallback `subscriber_id`

### Tool / command layer

需要改：

- `/rename`
- `/bus send`
- `/launch`
- `/group` 相关 agent 查找
- 所有 nickname lookup helper

解析规则：

- 先尝试 subscriber id
- 再尝试原始 `nickname`
- 再尝试 `scoped_nickname`

## Migration Strategy

兼容旧数据，不做一次性强迁移。

旧 entry 只有：

```json
{
  "nickname": "neptune-builder"
}
```

读取兼容策略：

- 如果没有 `scoped_nickname`
  - 先认为 `scoped_nickname = nickname`
  - 再尝试按当前项目名前缀推导原始 `nickname`
- 若无法安全推导
  - 则保留原值作为 `nickname`

新写入统一写双字段。

这保证：

- 老项目不崩
- 新项目从第一天开始使用双字段
- UI 可以逐步恢复成人类可读昵称

## Suggested Rollout

### Phase 1: Bus schema + lookup

- 为 bus entry 增加 `scoped_nickname`
- 更新 nickname resolve / collision 逻辑
- 保持旧字段兼容读取

### Phase 2: Daemon launch / rename / resume

- launch 时保存：
  - `nickname`
  - `scoped_nickname`
- rename 时同步更新两者
- resume / recover 路径保留两者不丢

### Phase 3: UI display cleanup

- chat/dashboard/group output 默认显示 `nickname`
- 所有展示 fallback 逻辑统一

### Phase 4: Prompt path cleanup

- group bootstrap 只注入原始 `nickname`
- route/main/loop prompt 都只注入原始 `nickname`
- 避免将 scoped 值暴露给模型

### Phase 5: Runtime state normalization

- 把 group runtime 中的 `runtime_nickname` 逐步替换/并存为 `scoped_nickname`
- 清理历史命名混用

## Acceptance Criteria

### Control plane

- 不同项目中，`builder` 不冲突
- bus 能唯一解析到 `neptune-builder`
- `subscriber_id` 仍然是最终落点

### UX

- chat/dashboard 默认只显示 `builder`
- 不再默认显示 `neptune-builder`
- group diagram / member list 与模板语义一致

### AI behavior

- bootstrap / routing prompt / group context 只出现 `builder / reviewer / architect`
- 不再把项目名前缀混入角色名

### Compatibility

- 旧 `nickname` 单字段数据仍能读取
- `/rename`、`/bus send`、`/group` 支持：
  - 原始昵称
  - scoped 昵称
  - subscriber id

## Recommendation

这是一个值得做的结构性修正。

最核心的原则是：

- 给人和模型看的名字，保持干净、稳定、语义化
- 给控制面做唯一性隔离的名字，单独建模，不再污染展示和 prompt

简化成一句话：

`nickname` 给用户和模型，`scoped_nickname` 给系统。
