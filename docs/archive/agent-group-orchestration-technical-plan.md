# ufoo Agent Group 编排技术方案（Plan）

Date: 2026-02-23
Status: implemented
Base requirements: `docs/agent-group-orchestration-requirements.md`
Related decisions:
- `.ufoo/context/decisions/0226-ucode-5-architecture-review-agent-group-orchestration-template-risks-and-suggestions.md`
- `.ufoo/context/decisions/0227-codex-4-adopt-0226-review-and-phase-agent-group-implementation-with-send-hooks-and-transactional-orchestrator.md`
- `.ufoo/context/decisions/0228-codex-4-technical-implementation-plan-for-agent-group-orchestration-v1-with-phase-gates-and-acceptance-criteria.md`

## Implementation Audit (2026-04-26)

Phases A-E have landed in the current codebase: `src/group/templates.js`,
`src/group/validateTemplate.js`, `src/group/diagram.js`,
`src/daemon/groupOrchestrator.js`, daemon IPC, CLI integration, and chat command
integration are present. `src/bus/message.js` now exposes `preSendHooks`, and
`EventBus` registers the warn-only group policy hook for `accept_from`.

## 1. 目标与边界
- 在现有单 Agent `launch_agent` 基础上，新增模板驱动的多 Agent group 编排。
- v1 提供可用闭环：模板管理、事务化启动、状态可见、可停止、可画拓扑图。
- v1 不做硬 ACL；仅提供 soft-check + hook 扩展点，为 v2 保留升级路径。

## 2. 架构分层

### 2.1 新增模块
- `src/group/templates.js`
  - 负责模板加载、优先级合并、alias 查找、模板创建复制。
- `src/group/validateTemplate.js`
  - 负责模板结构校验与引用校验，输出明确错误路径。
- `src/group/diagram.js`
  - 负责把 template/runtime 渲染为 ASCII 图。
- `src/daemon/groupOrchestrator.js`
  - 负责 compile launch plan、执行、回滚、group runtime 持久化。

### 2.2 扩展模块
- `src/shared/eventContract.js`
  - 新增 group IPC types：`LAUNCH_GROUP`、`STOP_GROUP`、`GROUP_STATUS`、`GROUP_DIAGRAM`、`GROUP_TEMPLATE_VALIDATE`。
- `src/daemon/index.js`
  - `handleRequest` 增加 group 分支，调用 `groupOrchestrator`。
- `src/cli.js`
  - 增加 `ufoo group ...` 命令簇。
- `src/chat/commands.js`、`src/chat/commandExecutor.js`
  - 增加 `/group ...` 指令。
- `src/bus/message.js`
  - 增加 `preSendHooks` 调用位（v1 warn-only）。

## 3. 数据与文件契约

### 3.1 模板目录
- 内置：`templates/groups/*.json`
- 项目：`.ufoo/templates/groups/*.json`
- 全局：`~/.ufoo/templates/groups/*.json`

加载优先级：项目 > 全局 > 内置。

### 3.2 Group 运行态
- 目录：`.ufoo/groups/`
- 文件：`.ufoo/groups/<group-id>.json`
- 核心字段：
  - `group_id`
  - `template_alias`
  - `template_version`
  - `status` (`starting|active|failed|stopped`)
  - `members[]`（template agent id/nickname -> subscriber id）
  - `started_at`/`updated_at`
  - `errors[]`

## 4. 关键流程

### 4.1 `group run`
1. 读取模板并校验。
2. 编译启动计划（按 `startup_order + depends_on` 分批次）。
3. 调用现有 daemon launch 能力逐批执行。
4. 任意失败时执行反向回滚（close 已启动 subscriber）。
5. 写入 group runtime，返回结构化结果。

### 4.2 `group stop`
1. 读取 group runtime 的活跃成员。
2. 逆序 close。
3. 更新 group runtime 状态为 `stopped`。

### 4.3 `group status/diagram`
1. 从 runtime 读取当前状态。
2. 结合模板渲染成员状态与边关系。

## 5. Phase Plan（实施顺序）

## Phase A: Template 基础层
范围：
- `templates.js` + `validateTemplate.js`
- CLI: `group template validate/show/list`

验收：
- 不合法模板返回明确错误路径（例：`edges[2].to`）。
- 可正确加载三层模板并按优先级覆盖。

测试：
- 模板边界用例（空 agents、重复 nickname、非法引用、非法 type、无效 startup_order）。

## Phase B: 事务化编排层
范围：
- `groupOrchestrator.js`
- daemon IPC: `LAUNCH_GROUP`、`STOP_GROUP`、`GROUP_STATUS`
- runtime state 持久化

验收：
- 启动全成功：状态 `active`。
- 第 N 个失败：前 N-1 必须回滚并状态 `failed`。
- stop 后状态 `stopped` 且成员无活跃残留。

测试：
- 注入 launch 失败验证 rollback。
- 状态文件一致性测试（启动中断/异常恢复）。

## Phase C: 命令与交互层
范围：
- `ufoo group ...` CLI 完整命令面
- chat `/group ...` 支持

验收：
- CLI 与 chat 都能触发 run/status/stop/template validate。
- 错误路径对用户可读。

## Phase D: 图渲染层
范围：
- `diagram.js` + CLI/chat 输出

验收：
- 至少支持 ASCII 渲染。
- 可显示 member 状态（active/failed/stopped）。

## Phase E: send hook（v1 软检查）
范围：
- `src/bus/message.js` 新增 `preSendHooks`
- group policy 注册 warn-only hook

验收：
- 违反 `accept_from` 时输出 warning，但消息仍投递。
- 默认无 hook 时行为与当前一致。

## 6. IPC 草案

请求：
- `LAUNCH_GROUP`: `{ type, alias, instance?, dry_run? }`
- `STOP_GROUP`: `{ type, group_id }`
- `GROUP_STATUS`: `{ type, group_id? }`
- `GROUP_DIAGRAM`: `{ type, alias?, group_id?, format? }`
- `GROUP_TEMPLATE_VALIDATE`: `{ type, alias? path? }`

响应：
- 复用 `IPC_RESPONSE_TYPES.RESPONSE`，在 `data.group` 字段返回结构化 payload。

## 7. 风险与缓解
- 风险：send 主路径改动引发兼容问题  
  缓解：仅新增可选 hook，默认空数组，保证无行为变化。
- 风险：group 半启动残留  
  缓解：强制事务化回滚 + runtime 落盘状态机。
- 风险：chat 生成模板质量不稳定  
  缓解：所有写入前强制走 `validateTemplate`。

## 8. 验收定义（v1 Done）
- `ufoo group run <alias>` 可稳定启动多 agent。
- 失败必回滚，且 `.ufoo/groups/*.json` 状态准确。
- `ufoo group status/stop/diagram` 可用。
- 模板 validate 覆盖关键边界。
- send hook warn-only 上线，v2 可直接切换 enforce 模式。
