# ufoo Prompt Envelope & Message Tags 方案

## 背景

ufoo 框架向 agent 注入的 prompt 来源不统一,目前存在两个独立的渲染点:

- `src/coordination/bus/index.js:396` — `ufoo bus check` 列出 pending 消息时拼 `[ufoo]<from:id(nickname)>`
- `src/coordination/history/inputTimeline.js:548,563` — Team Activity 时间线渲染 `[ufoo]<from:...>` 与 `[manual]<to:...>`

两处各自字符串拼接,容易漂移。同时,sender 当前没法在消息上声明"完成后必须回执""完成后必须 report",协议里只有一条软规则"reply to sender, then ack",agent 经常忽略。

## 核心契约

**标签是 bus metadata contract,不是 prompt header 文本本身。**

- 消息事件的 `data.tags`、`data.task_id`、`data.report_to` 是权威来源。
- envelope header 是给人和 LLM 看的渲染产物,由 metadata 生成。
- 框架行为(自动消费、timeline、controller 派发、report 路由)必须读 metadata,不要 reverse-parse header。
- 缺字段兼容旧版:`tags` 缺省视为空数组/软回执,`task_id` 缺省时 report 不带 `--task`,`report_to` 缺省时按现有 controller 规则推断。

## 目标

1. **统一 envelope 渲染**:框架层只有一个渲染器输出注入到 agent prompt 的 ufoo 文本。
2. **引入消息标签**:sender 显式声明完成后的动作要求(回执 / 上报 / 仅周知),写进消息元数据,渲染到 envelope header。
3. **消费路径对齐**:所有机器消费路径直接读 metadata,包括 ucode 自动消费、`bus check` fallback parser、timeline 与 controller/report 路径。
4. **协议落地**:在所有发送/消费路径都识别 metadata 后,再更新 bootstrap、`SKILL.md` 和 `ubus` skill 文案。

## Envelope 格式

每条 ufoo 注入文本固定形如:

```text
<header line>
<message body...>
```

Header 字段顺序固定,空格分隔:

```text
[ufoo]<from:claude-code:abc123(architect)> [reply] [report] [task:T-42]
```

- `[ufoo]<from:id(nickname)>` 或 `[manual]<to:id(nickname)>` —— 必填,框架填
- 动作标签(`[reply]` / `[report]` / `[fyi]`) —— 可选,来自 `data.tags`
- 元信息标签(`[task:<id>]`) —— 可选,来自 `data.task_id`

manual 输入与 bus 消息共享同一个 envelope 渲染器,前者用 `[manual]<to:...>`,后者用 `[ufoo]<from:...>`。

`bus check` 的非 verbose 输出应直接采用 envelope 形态:

```text
[ufoo]<from:claude-code:abc123(architect)> [reply] [task:T-42]
review src/main.ts
```

调试字段如 `Type`、完整 JSON `Content` 可放到 `--verbose` 输出,避免 agent prompt 同时出现两套协议载体。

## 标签集合

### 动作类

| 标签 | 语义 | 完成后必须做 |
|---|---|---|
| `[reply]` | 强制回执给 sender | `ufoo bus send <sender-id> "<result>"`,然后 `ufoo bus ack` |
| `[report]` | 上报 controller | `ufoo report done ...`,然后 `ufoo bus ack` |
| `[fyi]` | 仅周知 | 直接 `ufoo bus ack`,不要回执、不要 report |
| (无标签) | 软回执 | 协议建议回复 sender 但不强制,`ufoo bus ack` 必做 |

`[reply]` 和 `[report]` 可以同时出现,表示既回 sender 又上报 controller。`[fyi]` 与 `[reply]` / `[report]` 互斥。

### 元信息类

| 标签 | 来源 | 语义 |
|---|---|---|
| `[task:<id>]` | `data.task_id` | 关联 task,后续 reply/report 自动带这个 id |
| `[blocking]` | v2,本轮不做 | sender 在阻塞等待,优先处理 |

### 命名理由

- `[reply]` 不用 `[ack]` —— 避免和 `ufoo bus ack` 命令撞名,后者是消费自己队列、前者是回复对方。
- `[report]` 直接对应 `ufoo report` 命令。
- `[fyi]` 字面就是 "for your information",意图明确。

## CLI 映射

保持当前 `bus send` 参数解析习惯:flags 放在 target/message 之前。

```bash
ufoo bus send --reply <target> "<msg>"               # -> [reply]
ufoo bus send --report <target> "<msg>"              # -> [report]
ufoo bus send --reply --report <target> "<msg>"      # -> [reply] [report]
ufoo bus send --fyi <target> "<msg>"                 # -> [fyi]
ufoo bus send --reply --task T-42 <target> "<msg>"   # -> [reply] [task:T-42]
```

无 flag 时不写 tags,行为与现在完全一致。

`parseTagsFromOptions` 规则:

- tags 去重,固定渲染顺序:`reply` -> `report` -> `fyi` -> `task:<id>`。
- `[fyi]` 与 `[reply]` / `[report]` 同时出现时报错。
- `task_id` 只允许 `[A-Za-z0-9_.-]+`,长度上限建议 64,避免 header 注入或空格破坏 parser。
- tag 总数设上限,防止 header 失控。

## 消息元数据

`src/coordination/bus/messageMeta.js#buildMessageData` 在 `data` 里新增:

```js
{
  message,
  injection_mode,
  source,
  tags: ["reply", "report"],   // 可选,空数组时省略
  task_id: "T-42",             // 可选
  report_to: "ufoo-agent",     // 可选,用于 [report] controller 路由
}
```

`data.report_to` 优先级:

1. sender 显式传入的 `report_to`
2. group/runtime metadata 里的 `controller_id`
3. 现有默认 controller 规则

无 `task_id` 时,`[report]` 仍可执行,但 `ufoo report done` 不带 `--task`;summary 使用回执/执行结果文本。

## 实施改动点

### 1. 新建 `src/coordination/bus/envelope.js`

```js
// renderEnvelope({ kind, fromId, fromNickname, toId, toNickname, tags, taskId, message }) -> string
// parseTagsFromOptions(options) -> { tags: string[], taskId: string, reportTo: string }
// formatTagList({ tags, taskId }) -> string
```

`renderEnvelope` 只负责渲染 metadata,不承担协议状态判断。

### 2. 扩展 metadata schema

- 在 `messageMeta.js` 增加 `tags`、`task_id`、`report_to` 规范化。
- 缺字段按旧行为处理。
- 为 tag 去重、互斥、`task_id` 校验补单元测试。

### 3. 所有发送入口透传 tags/task_id/report_to

本轮必须覆盖:

- CLI:`src/app/cli/busCoreCommands.js`
- Chat `/bus send` 命令:`src/app/chat/commandExecutor.js`
- Chat input/dispatch 里直接发 `BUS_SEND` 的路径:`src/app/chat/inputSubmitHandler.js`、`src/app/chat/index.js`
- Daemon IPC:`BUS_SEND` 处理路径:`src/runtime/daemon/index.js`
- Controller 派发/工具路径:`src/agents/controller/controllerToolExecutor.js` 及相关 dispatch path

每个入口都要把 options 透传到 `MessageManager.send()`,最终落到 `data.tags` / `data.task_id` / `data.report_to`。未传 tags 视为软回执,行为等价旧版。

### 4. 渲染端切换

| 文件 | 现状 | 改为 |
|---|---|---|
| `src/coordination/bus/index.js:396` | 自拼 `[ufoo]<from:...>` + JSON Content | 调 `renderEnvelope(...)` 输出 header + message body |
| `src/coordination/history/inputTimeline.js:544-567` | `formatEntry` / `renderTimelineForPrompt` 自拼 | 同上,从 timeline entry 的 tags/task_id 渲染 |

`src/coordination/history/inputTimeline.js#appendBusEntry` 需要同步扩 schema:

```js
{
  seq,
  timestamp,
  publisher,
  target,
  message,
  tags,
  task_id,
}
```

旧 entry 缺字段时按空数组/空字符串渲染,watermark 不需要变。

### 5. 消费入口对齐

#### `bus check` fallback parser

`src/code/agent.js#parseBusCheckOutput` 必须和 `bus check` envelope 渲染在同一次提交更新,避免中间态。测试覆盖:

- 旧消息无 tags
- 单标签、多标签
- `[task:<id>]`
- `[manual]<to:...>`
- message 跨多行
- verbose JSON content 不影响普通 parser

#### ucode 自动消费

`src/code/agent.js#extractTaskFromBusEvent` 返回:

```js
{
  publisher,
  task,
  tags,
  taskId,
  reportTo,
}
```

自动消费策略:

- `[fyi]`:直接 ack,不发 start、不回执、不 report。
- `[reply]`:完成后 `ufoo bus send <publisher> "<result>"`。
- `[report]`:完成后 `ufoo report done --controller <reportTo> --agent "$UFOO_SUBSCRIBER_ID" --scope public`,有 `taskId` 时加 `--task <taskId>`。
- `[reply]` + `[report]`:两件都做。
- 无 action tag:保持旧软回执行为。

`task_id` 需要透传到 start/progress/done/error report 以及回执文本或 metadata。

### 6. 注入触发器不变

`src/coordination/bus/inject.js` 仍只往目标终端打 `/ubus`(claude)或 `ubus`(codex)。真正 envelope 文本在 agent 自己跑 `ufoo bus check` 时由渲染器输出,不直接把 prompt body 写进终端。

### 7. 协议文档更新

在所有发送/消费路径都能识别 metadata 后,再更新:

- `src/orchestration/groups/bootstrap.js#SHARED_UFOO_PROTOCOL`
- `SKILLS/ufoo/SKILL.md`
- `modules/bus/SKILLS/ubus/SKILL.md`
- `modules/AGENTS.template.md`
- `src/agents/prompts/native/ufoo.js`
- `src/code/UCODE_PROMPT.md`

协议文案应表达:

```text
ufoo message tags:
- [reply]   After finishing, send a result back to the sender, then ack.
- [report]  After finishing, report done to the controller, then ack.
- [fyi]     No reply/report expected; just ack.
- [task:<id>] Carry this id in subsequent reply/report when available.
- No action tag = soft reply expected; ack is always required.
- [reply] and [report] can co-occur; [fyi] is mutually exclusive with both.
```

LLM 文案可以说"读取 header tags",但实现代码必须读 metadata。

### 8. 兜底机制(后续轮次,不阻塞)

- daemon 侧记录 `[reply]` / `[report]` 消息发出时间,N 分钟无对应回执 -> 推 reminder 给 sender。
- `ufoo bus status` 多一列 `pending replies` 与 `pending reports`。
- 这块涉及 daemon ops,等 envelope + 标签跑通后单独立项。

## 实施顺序

1. **Schema + 校验定型**:`messageMeta.js` 新字段、`envelope.js` 渲染器、`parseTagsFromOptions` 校验规则、单元测试。
2. **所有发送入口透传**:CLI / chat / daemon IPC / controller dispatch。每改一处就加测试。
3. **所有消费入口对齐**:
   - `bus check` 渲染切 envelope 同时更新 `parseBusCheckOutput`。
   - `extractTaskFromBusEvent` 与 ucode 自动消费策略读取 tags/task_id/report_to 分流。
   - timeline 渲染走 envelope,`appendBusEntry` 落 tags/task_id。
4. **bootstrap.js + skill/prompt 文案**:在所有路径都能识别标签后再发协议升级。
5. **后续**:daemon 兜底、超时 reminder、`pending replies/reports` 状态列。

## 兼容性

- 旧消息事件 `data.tags` 不存在 -> 按空数组处理,header 只出现 from/to 段。
- 旧 timeline entry 缺 `tags` / `task_id` -> 按无标签渲染。
- 老 agent 没读到新协议 -> 无标签消息仍按旧软回执处理;新标签只在新 bootstrap/skill 文案生效后被明确要求。
- CLI 不传任何新 flag -> 完全等价旧行为。
- `bus check` 输出切换必须与 fallback parser 同步提交,不能拆成两个中间态。

## 不在本轮范围

- daemon 层兜底/超时 reminder
- `[blocking]` / `[urgent]` 等额外标签
- envelope 多语言/本地化
- 把 ack 的清队列动作也做成 sender 可控(目前 ack 始终必做)
