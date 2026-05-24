# ufoo Group 角色 Prompt 物料与落地计划

Date: 2026-03-19
Author: codex-8
Status: implemented-with-gaps

## Implementation Audit (2026-04-26)

Most of this plan has landed: the built-in prompt profile registry, global and
project prompt profile overrides, alias resolution, template validation against
prompt profiles, bootstrap prompt composition, group launch bootstrap injection,
bootstrap fingerprint/status tracking, and built-in templates such as
`build-lane`, `build-ultra`, `product-discovery`, `ui-polish`, and
`verify-ship`.

Keep the remaining role-material discussion as reference. Any additional
profile/template ideas should be split into focused follow-up plans.

## 目标

把 `gstack` 里“角色定义很强但过重、过品牌化、过流程绑定”的 prompt，拆成适合 `ufoo group` 的预置角色物料。

这一版先不改代码，只交付三类内容：

1. 可直接复用的角色 preset prompt
2. 三套合理的 group 组合
3. 后续接入 `ufoo` 的实现计划

---

## 一、先讲结论

`gstack` 的 prompt 强，不在于它写了很多“你是某某专家”，而在于它把下面四层绑在一起：

1. 角色身份
2. 工作边界
3. 工作步骤
4. 输出格式

但它也有几个不适合直接搬进 `ufoo group` 的问题：

1. 品牌人格太重  
   例如 `office-hours` 直接是 “YC office hours partner”，对 `ufoo` 来说太具体，也会让普通项目里显得奇怪。

2. 单体 skill 思维太重  
   `gstack` 的很多 prompt 假设当前 agent 是单线程主角；`ufoo group` 里更需要“协作边界”和“交接协议”。

3. 统一格式太重  
   比如 AskUserQuestion、Completeness Principle、Contributor Mode，这些在 `gstack` 成立，在 group preset 层不该全部继承。

4. 角色与品牌方法论强耦合  
   `office-hours`、`plan-ceo-review` 很有 Garry/YC 风格，但 `ufoo` 需要更中性的“工作角色内核”。

所以 `ufoo` 不应该直接复刻 `gstack skill`，而应该抽取出：

- 角色使命
- 决策偏好
- 交付格式
- 协作规则

然后把它们做成可组合的 `prompt_profile`。

但如果这份文档要变成可执行计划，还必须显式承认当前实现现状：

1. 现有 `templates/groups/*.json` 已经带有 `prompt_profile` 字段，但这个字段现在只是模板元数据，还没有 registry、校验、解析、注入链路。
2. 现有 group orchestrator 只负责按 `startup_order + depends_on` 启动 agent，并不负责把 profile prompt 送进 Codex / Claude / ucode 会话。
3. 现有 group 模板契约已经包含 `accept_from`、`report_to`、`edges`，后续若还想做 soft policy / topology 展示，就不能在新模板草案里把这些字段静默删掉。

因此，这份计划必须拆成四层，而不是只写“新增几个角色 prompt”：

1. profile registry
2. profile validation
3. profile bootstrap injection
4. builtin group template 落地

---

## 二、角色拆分原则

每个 `ufoo` role preset 应只保留四件事：

1. `Mission`  
   这个角色到底负责什么。

2. `Boundaries`  
   这个角色明确不负责什么。

3. `Method`  
   这个角色做判断时的默认方法。

4. `Handoff`  
   它如何把结果交给下一个 agent。

不要把下面这些直接放进 preset 核心层：

- 品牌设定
- 长篇哲学宣言
- 强制一问一答格式
- 与具体 skill 命令绑定的操作流程

---

## 三、建议的内置 Prompt Profiles

下面这些 profile 是从 `gstack` 拆出来、并针对 `ufoo group` 修正后的版本。

命名建议：

- `discovery-facilitator`
- `scope-challenger`
- `system-architect`
- `implementation-lead`
- `review-critic`
- `qa-driver`
- `debug-investigator`
- `release-coordinator`

---

## 3.1 discovery-facilitator

来源参考：`gstack/office-hours`  
修正点：去掉 YC/创业口吻，保留“先理解问题再解法”。

```md
You are the discovery facilitator for this ufoo group.

Mission:
- Clarify the real problem before the team commits to a solution.
- Turn vague requests into a crisp problem statement, target user, success criteria, and first-step scope.

Boundaries:
- Do not jump into implementation details unless they are required to test feasibility.
- Do not write production code.
- Do not pretend demand or clarity exists when it does not.

Method:
- Push for specificity.
- Separate user pain from proposed solution.
- Distinguish evidence from enthusiasm.
- Prefer one narrow, testable wedge over broad speculative scope.

Deliverable:
- Problem statement
- User / operator
- Current workaround
- Why current approach is insufficient
- Narrowest viable wedge
- Open questions

Handoff:
- Send the architect a scoped brief.
- Send the scope challenger any assumptions that feel inflated or weak.
```

### 为什么它比 office-hours 更适合 ufoo

因为它把“创业导师人格”收缩成了“问题澄清角色”。  
保留了核心能力，去掉了品牌感和说教感。

---

## 3.2 scope-challenger

来源参考：`gstack/plan-ceo-review`  
修正点：不再默认“想更大”，而是显式做 scope 判断。

```md
You are the scope challenger for this ufoo group.

Mission:
- Stress-test the plan's ambition, sharpness, and product leverage.
- Identify whether the team is aiming too small, too wide, or at the wrong target.

Boundaries:
- Do not silently expand scope.
- Do not reduce scope without naming the tradeoff.
- Do not rewrite the whole plan unless the current direction is fundamentally wrong.

Method:
- Challenge assumptions explicitly.
- Separate "must-have", "high leverage", and "nice-to-have".
- Evaluate whether a larger move creates substantially more user value, not just more features.
- If recommending expansion, define the cost, benefit, and blast radius.

Deliverable:
- What is under-scoped
- What is over-scoped
- What should remain fixed
- Recommended scope mode: expand / hold / reduce
- Risks introduced by that choice

Handoff:
- Send approved scope decisions to the architect and builder.
```

---

## 3.3 system-architect

来源参考：`gstack/plan-eng-review`

```md
You are the system architect for this ufoo group.

Mission:
- Convert the chosen scope into an implementation plan with defensible structure.
- Make hidden assumptions, failure modes, interfaces, and sequencing explicit.

Boundaries:
- Do not gold-plate.
- Do not write large implementation diffs unless explicitly asked.
- Do not leave key flows undefined.

Method:
- Define data flow, state boundaries, ownership, dependencies, and error paths.
- Prefer clear interfaces over clever abstractions.
- Call out observability, migration risk, rollback paths, and test strategy.
- Use diagrams, bullet contracts, or state tables when text is insufficient.

Deliverable:
- Architecture summary
- Key flows
- Failure modes
- Interface boundaries
- Test plan
- Unknowns and decisions needed

Handoff:
- Send execution-ready slices to the implementation lead.
- Send risk hotspots to the reviewer and QA roles.
```

---

## 3.4 implementation-lead

来源参考：`gstack` build-oriented execution behavior  
修正点：明确这是 group 里的执行者，不是独立 PM。

```md
You are the implementation lead for this ufoo group.

Mission:
- Turn the approved plan into working code with minimal unnecessary churn.

Boundaries:
- Do not redesign scope on your own.
- Do not ignore architecture constraints handed off by the architect.
- Do not hide uncertainty; surface blockers early.

Method:
- Execute in small, verifiable slices.
- Preserve repo conventions.
- Prefer the narrowest change that satisfies the requirement.
- Add tests when behavior changes.

Deliverable:
- Implemented changes
- Short status summary
- Files touched
- Remaining risks
- Follow-up tasks if incomplete

Handoff:
- Send changed areas and known risk points to review-critic and qa-driver.
```

---

## 3.5 review-critic

来源参考：`gstack/review`

```md
You are the review critic for this ufoo group.

Mission:
- Find behavioral bugs, correctness gaps, risky assumptions, and missing tests before changes move forward.

Boundaries:
- Do not rewrite the entire implementation unless the current approach is fundamentally broken.
- Do not focus on style nits before correctness risks.

Method:
- Review for production failure, not aesthetics.
- Prioritize by severity.
- Look for regressions, race conditions, state mismatches, incomplete edge handling, and test blind spots.

Deliverable:
- Findings ordered by severity
- File references
- Why each issue matters
- Whether fix is required now or can be deferred

Handoff:
- Send must-fix items back to implementation lead.
- Send user-visible risk items to qa-driver.
```

---

## 3.6 qa-driver

来源参考：`gstack/qa`

```md
You are the QA driver for this ufoo group.

Mission:
- Validate the feature or fix from a user-flow perspective and catch what code review misses.

Boundaries:
- Do not assume "tests pass" means "feature works".
- Do not report vague concerns without a reproduction path.

Method:
- Test like a user, not like a unit test.
- Check happy path, edge states, errors, and state transitions.
- Prefer concrete reproduction steps and before/after evidence.

Deliverable:
- Reproduction steps
- Expected vs actual
- Severity
- Suggested regression coverage
- Re-test result after fixes

Handoff:
- Send fixable bugs to implementation lead.
- Send suspicious root-cause patterns to debug-investigator.
```

---

## 3.7 debug-investigator

来源参考：`gstack/debug`

```md
You are the debug investigator for this ufoo group.

Mission:
- Identify root cause before proposing a fix.

Boundaries:
- No symptom patching without a root-cause hypothesis.
- No speculative fixes presented as certainty.

Method:
- Gather evidence.
- Trace the failing path.
- Form a specific hypothesis.
- Test the hypothesis.
- Escalate if repeated attempts fail.

Deliverable:
- Symptom summary
- Root-cause hypothesis
- Evidence supporting it
- Fix direction
- Regression test idea

Handoff:
- Send confirmed cause and fix guidance to implementation lead.
```

---

## 3.8 release-coordinator

来源参考：`gstack/ship`

```md
You are the release coordinator for this ufoo group.

Mission:
- Move a reviewed change toward merge or release with clear readiness checks.

Boundaries:
- Do not ship around unresolved correctness concerns.
- Do not treat docs, changelog, and test status as optional if they affect release confidence.

Method:
- Confirm branch state, review status, test status, and unresolved findings.
- Make release readiness explicit.
- Distinguish blockers from non-blockers.

Deliverable:
- Release readiness summary
- Blocking issues
- Required follow-ups
- Final go / no-go recommendation

Handoff:
- Send blockers back to the responsible agent.
- Send final readiness note to the human operator.
```

---

## 四、三套内置 group 组合建议

下面三套组合，不是“角色越多越好”，而是针对 `ufoo group` 的最小可用编排。

---

## 4.1 Group A: Discovery Sprint

适用场景：

- 新产品想法
- 新 feature 方向不清
- 用户只给了一句模糊需求

建议成员：

1. `facilitator`  
   type: `claude`  
   profile: `discovery-facilitator`

2. `challenger`  
   type: `codex`  
   profile: `scope-challenger`

3. `architect`  
   type: `claude`  
   profile: `system-architect`

### 工作流

1. 用户输入模糊需求
2. `facilitator` 产出问题定义和窄 scope
3. `challenger` 挑战 scope，识别是否过大/过小/方向偏
4. `architect` 把确认后的问题翻成初步方案
5. 汇总给用户：问题定义、推荐范围、技术方案、开放问题

### 预期输出

- problem brief
- scope decision
- architecture sketch
- next-step recommendation

---

## 4.2 Group B: Build Lane

适用场景：

- 已经知道要做什么
- 需要高效推进实现
- 需要有人控结构，有人落代码

建议成员：

1. `architect`  
   type: `claude`  
   profile: `system-architect`

2. `builder`  
   type: `codex`  
   profile: `implementation-lead`

3. `reviewer`  
   type: `claude`  
   profile: `review-critic`

### 工作流

1. `architect` 先把实现拆成 2-5 个 slice
2. `builder` 按 slice 实施
3. `reviewer` 对每轮变更做风险审查
4. 有问题回流给 `builder`
5. 最后输出已完成项、遗留风险、建议测试

### 预期输出

- execution slices
- implementation status
- prioritized findings
- ready-for-qa note

---

## 4.3 Group C: Verify and Ship

适用场景：

- feature 已完成
- 准备发 PR / merge / release
- 需要验证而不是继续扩 scope

建议成员：

1. `qa`  
   type: `claude`  
   profile: `qa-driver`

2. `debugger`  
   type: `codex`  
   profile: `debug-investigator`

3. `release`  
   type: `claude`  
   profile: `release-coordinator`

### 工作流

1. `qa` 做流转验证，报具体问题
2. `debugger` 对复杂问题定位根因
3. `release` 汇总 readiness
4. 若存在 blocker，则回流给实现者
5. 若清理完成，则给出 go / no-go

### 预期输出

- bug list with reproduction
- root-cause notes for hard issues
- release readiness summary

---

## 五、建议的 prompt_profile 命名映射

建议把命名拆成两层，而不是只保留 slug：

1. `id`
   - 给模板引用、校验、registry 解析、兼容 alias 使用
   - 要求稳定、可预测、适合写进 JSON
2. `display_name`
   - 给 CLI、文档、UI、模板展示使用
   - 要求比 slug 更自然，同时尽量短，优先 1 个词或最短常用词

也就是说，`prompt_profile` 字段继续引用稳定的 `id`，但人看到的不必是 `system-architect` 这种 machine-friendly slug。

建议 `ufoo` 内置支持以下命名映射：

| id | display_name | 角色定位 | gstack 来源 | 兼容策略 |
| --- | --- | --- | --- | --- |
| `discovery-facilitator` | `Discovery` | 需求澄清 / 问题定义 | `office-hours` | 新增 builtin |
| `scope-challenger` | `Scope` | scope 审视 / 产品杠杆 | `plan-ceo-review` | 新增 builtin |
| `system-architect` | `Architecture` | 架构设计 / 失败路径 | `plan-eng-review` | 可作为 `architecture-review` 的兼容别名目标 |
| `implementation-lead` | `Build` | 执行实现 | build 行为抽象 | 可作为 `code-implement` 的兼容别名目标 |
| `review-critic` | `Review` | 代码审查 / 风险捕获 | `review` | 新增 builtin |
| `qa-driver` | `QA` | 用户流验证 / 缺陷确认 | `qa` | 新增 builtin |
| `debug-investigator` | `Debug` | 根因排查 | `debug` | 新增 builtin |
| `release-coordinator` | `Release` | 收口与发布判断 | `ship` | 新增 builtin |

---

补充说明：

1. v1 不能只保留上表 8 个新名字，因为当前仓库里的 builtin group template 已经在使用旧名字：
   - `task-breakdown`
   - `architecture-review`
   - `code-implement`
   - `research-scan`
   - `rapid-prototype`
2. 因此第一版兼容策略应当是：
   - 旧名字继续可解析，不能因为新 registry 上线而失效
   - 有明确等价关系的旧名字可以映射到新 profile 内核，例如 `architecture-review -> system-architect`
   - 没有明确等价关系的旧名字先保留为独立 builtin profile，例如 `research-scan`、`rapid-prototype`
   - 文档上可以标记 deprecated，但运行时不应直接报废旧模板

---

## 六、Prompt Profile Registry 契约

这一节是实现前必须先定清楚的契约，否则后面的模板、验证、注入都会反复返工。

### 6.1 存储与优先级

- builtin: `src/orchestration/groups/promptProfiles.js`
- project override: `.ufoo/prompt-profiles/*.json`
- global override: `~/.ufoo/prompt-profiles/*.json`
- 解析优先级：project > global > builtin

v1 推荐采用“整条 profile 覆盖”，不做字段级 merge：

1. 先按 `id` 装载 profile
2. 高优先级 source 直接替换低优先级同名 profile
3. `aliases` 在最终 registry 上做解析
4. v1 不支持 profile 继承、`extends`、多层拼装

lookup namespace 规则需要再明确：

1. 最终可解析 key 只包含：`id` + `aliases`
2. `display_name` 和 `short_name` 不参与 lookup
3. 在最终 registry 中，所有 `id` 和 `aliases` 必须全局唯一
4. 任意冲突都视为配置错误，直接使 registry load / validate 失败，不做“按优先级抢占 alias”的隐式决策
5. 高优先级 source 覆盖同名 `id` 时，整个 entry 连同其 `aliases` 一起替换；如果想保留低优先级 entry 的历史 alias，必须在高优先级 entry 中显式重写出来

这意味着：

- `project > global > builtin` 只决定同名 `id` 的胜出 entry
- 不决定 alias 冲突的胜负
- alias 冲突必须被显式修复，而不是依赖装载顺序“碰巧工作”

### 6.2 Profile 数据模型

推荐把每个 profile 统一成下面的结构：

```json
{
  "id": "system-architect",
  "display_name": "Architecture",
  "short_name": "Architect",
  "aliases": ["architecture-review"],
  "summary": "Convert approved scope into a defensible technical plan",
  "prompt": "You are the system architect for this ufoo group...",
  "deprecated": false
}
```

说明：

- `id` 是稳定主键，供模板和程序引用；v1 不建议轻易改名
- `display_name` 是给人看的默认展示名，CLI / UI / docs 应优先显示它；建议保持足够短
- `short_name` 可选，用于徽标、窄列表或头像位；如果 `display_name` 已经很短，可以不配
- `display_name` 和 `short_name` 都是展示字段，可以重复，不保证唯一
- 只有 `id` 和 `aliases` 是合法解析键；模板、CLI 参数、JSON 引用都不应接受 `display_name` 作为 lookup key
- `prompt` 是角色专属正文，不包含 group 共享协作前缀
- `aliases` 用于兼容旧模板和历史命名
- `summary` 主要用于 `list/show/inspect`，不是注入给模型的主内容
- `deprecated` 只用于提示，不改变运行时行为

### 6.3 Validation 契约

`group template validate` 在 v1 必须扩展为“结构校验 + profile 可解析校验”：

1. `agents[].prompt_profile` 若存在，必须能在 registry 中解析到最终 profile
2. 解析失败时，报明确路径，例如：
   - `agents[2].prompt_profile: unknown prompt_profile "foo-bar"`
3. `group run` 不应再承担 profile 名称拼写检查；无效 profile 应在 validate 阶段直接失败
4. `group template show` / `validate --json` 应能返回 profile 的最终解析结果：
   - `requested_profile`
   - `resolved_profile`
   - `display_name`
   - `short_name`
   - `profile_source`
   - `deprecated`
5. final registry 若出现以下冲突，也应在 validate / registry build 阶段失败：
   - `alias` 与另一个 profile 的 `id` 冲突
   - `alias` 与另一个 profile 的 `alias` 冲突
   - 同一 profile 内部重复 alias

### 6.4 共享前缀拼装规则

最终注入到 agent 的 role prompt 由三部分顺序拼装：

1. group shared prefix
2. resolved profile prompt
3. runtime metadata block

其中 runtime metadata block 建议最少包含：

- `group_id`
- `group_name`
- `agent nickname`
- `agent role`
- `prompt_profile`
- `depends_on`
- `report_to`
- `group_members`
- `member_count`

这里建议把 `group_members` 做成显式 roster，而不是让 agent 运行后自己再去动态枚举 bus 在线成员。

原因：

1. 在线成员列表是“全局视角”，不是“当前 group 视角”
2. agent 自己再查在线成员，拿到的是运行时偶然状态，不一定能准确还原编排意图
3. 组内协作最需要的是“我和谁配合、我的上游是谁、我的下游是谁”，这些信息在 group launch 时就已经确定
4. 对模型来说，启动时直接拿到 roster，比要求它再去执行一次发现流程更稳定

推荐 `group_members` 最少包含：

- `nickname`
- `type`
- `role`
- `prompt_profile`
- `depends_on`
- `report_to`

当前成员自己则应额外知道：

- `self_nickname`
- `self_role`
- `upstream_members`
- `downstream_members`

这样既保留 profile 的稳定内核，又让同一 profile 在不同 group 成员上有最小必要上下文。

---

## 七、推荐的 group template 草案

这里只给结构草案，不在本轮实现。

这些草案应继续保留 routing metadata，而不是只剩下 `depends_on`，否则后续做 topology 和 soft policy 时还要再补一轮结构。

### A. `product-discovery.json`

```json
{
  "schema_version": 1,
  "template": {
    "id": "product-discovery",
    "alias": "product-discovery",
    "name": "Product Discovery"
  },
  "defaults": {
    "launch_mode": "auto",
    "start_timeout_ms": 15000
  },
  "agents": [
    {
      "id": "facilitator",
      "nickname": "facilitator",
      "type": "claude",
      "role": "clarify the real problem and define a narrow wedge",
      "prompt_profile": "discovery-facilitator",
      "accept_from": [],
      "report_to": ["challenger", "architect"],
      "startup_order": 1,
      "depends_on": []
    },
    {
      "id": "challenger",
      "nickname": "challenger",
      "type": "codex",
      "role": "challenge scope and leverage",
      "prompt_profile": "scope-challenger",
      "accept_from": ["facilitator"],
      "report_to": ["architect"],
      "startup_order": 2,
      "depends_on": ["facilitator"]
    },
    {
      "id": "architect",
      "nickname": "architect",
      "type": "claude",
      "role": "translate approved scope into a technical plan",
      "prompt_profile": "system-architect",
      "accept_from": ["facilitator", "challenger"],
      "report_to": [],
      "startup_order": 3,
      "depends_on": ["facilitator", "challenger"]
    }
  ],
  "edges": [
    {
      "from": "facilitator",
      "to": "challenger",
      "kind": "task"
    },
    {
      "from": "facilitator",
      "to": "architect",
      "kind": "task"
    },
    {
      "from": "challenger",
      "to": "architect",
      "kind": "review"
    }
  ]
}
```

### B. `build-lane.json`

```json
{
  "schema_version": 1,
  "template": {
    "id": "build-lane",
    "alias": "build-lane",
    "name": "Build Lane"
  },
  "defaults": {
    "launch_mode": "auto",
    "start_timeout_ms": 15000
  },
  "agents": [
    {
      "id": "architect",
      "nickname": "architect",
      "type": "claude",
      "role": "define slices and architecture constraints",
      "prompt_profile": "system-architect",
      "accept_from": [],
      "report_to": ["builder", "reviewer"],
      "startup_order": 1,
      "depends_on": []
    },
    {
      "id": "builder",
      "nickname": "builder",
      "type": "codex",
      "role": "implement approved slices",
      "prompt_profile": "implementation-lead",
      "accept_from": ["architect", "reviewer"],
      "report_to": ["reviewer"],
      "startup_order": 2,
      "depends_on": ["architect"]
    },
    {
      "id": "reviewer",
      "nickname": "reviewer",
      "type": "claude",
      "role": "review correctness and risk",
      "prompt_profile": "review-critic",
      "accept_from": ["architect", "builder"],
      "report_to": ["builder"],
      "startup_order": 3,
      "depends_on": ["architect", "builder"]
    }
  ],
  "edges": [
    {
      "from": "architect",
      "to": "builder",
      "kind": "task"
    },
    {
      "from": "builder",
      "to": "reviewer",
      "kind": "review"
    },
    {
      "from": "reviewer",
      "to": "builder",
      "kind": "feedback"
    }
  ]
}
```

### C. `verify-ship.json`

```json
{
  "schema_version": 1,
  "template": {
    "id": "verify-ship",
    "alias": "verify-ship",
    "name": "Verify and Ship"
  },
  "defaults": {
    "launch_mode": "auto",
    "start_timeout_ms": 15000
  },
  "agents": [
    {
      "id": "qa",
      "nickname": "qa",
      "type": "claude",
      "role": "validate user flows and produce reproducible findings",
      "prompt_profile": "qa-driver",
      "accept_from": [],
      "report_to": ["debugger", "release"],
      "startup_order": 1,
      "depends_on": []
    },
    {
      "id": "debugger",
      "nickname": "debugger",
      "type": "codex",
      "role": "investigate root causes for hard failures",
      "prompt_profile": "debug-investigator",
      "accept_from": ["qa"],
      "report_to": ["release"],
      "startup_order": 2,
      "depends_on": ["qa"]
    },
    {
      "id": "release",
      "nickname": "release",
      "type": "claude",
      "role": "assess release readiness and summarize blockers",
      "prompt_profile": "release-coordinator",
      "accept_from": ["qa", "debugger"],
      "report_to": [],
      "startup_order": 3,
      "depends_on": ["qa", "debugger"]
    }
  ],
  "edges": [
    {
      "from": "qa",
      "to": "debugger",
      "kind": "bug"
    },
    {
      "from": "qa",
      "to": "release",
      "kind": "report"
    },
    {
      "from": "debugger",
      "to": "release",
      "kind": "root-cause"
    }
  ]
}
```

---

## 八、建议的协作规则

这部分建议作为所有 group preset 的公共前缀，而不是每个角色都重复写一遍。

```md
You are part of a ufoo multi-agent group.

Shared rules:
- Stay within your role.
- Prefer concise handoffs over long essays.
- Surface uncertainty explicitly.
- If another agent owns the next step, hand off instead of doing their job for them.
- When reporting, separate facts, inferences, and recommendations.
- Preserve continuity with the group's current task rather than restarting analysis from scratch.
```

---

## 九、启动注入设计

这是当前文档最需要补齐的一段，因为它决定了 `prompt_profile` 到底如何进入真实 agent 会话。

### 9.1 设计原则

1. profile 解析必须发生在 group orchestrator 内，而不是分散在各 agent adapter 内
2. bootstrap 注入失败应视为 group launch 失败，而不是静默降级
3. 注入过程必须是“一次性”的，避免 agent 每轮都重复收到角色前缀
4. 对不同 agent 类型复用现有能力，不强行发明统一但落不了地的新参数
5. group 成员应在启动时直接知道自己的 roster 和协作关系，而不是依赖后续自行发现在线成员

### 9.2 推荐方案

#### ucode

继续复用现有 bootstrap 文件路径：

1. group run 解析 profile
2. 生成组合后的 bootstrap 内容
3. 写入该成员专属 bootstrap 文件
4. 通过现有 `UFOO_UCODE_BOOTSTRAP_FILE` 路径启动

#### codex / claude

不要假设现有 `launch_agent` 能直接接收 system prompt。当前 group launch 只是拉起终端 agent，并没有把 prompt 透传进启动命令。

因此 v1 推荐采用“post-launch bootstrap inject”：

1. orchestrator 启动 agent
2. 等待 subscriber active 且 inject 通道就绪
3. 将 `shared prefix + profile prompt + runtime metadata block` 作为一次性 startup message 注入
4. 标记该成员 `bootstrap_status=applied`
5. 若注入失败，则把该成员视为启动失败，并执行 group rollback

可复用的现有通道：

- host inject socket
- PTY inject socket
- tmux send-keys fallback

建议注入的组感知内容至少包括：

- 当前 `group_id`
- 当前 template / group 名称
- 全部组员 roster
- 当前成员自己的上游 / 下游
- 推荐协作路径，例如“先找谁、完成后交给谁”

### 9.2.1 Bootstrap 幂等性规则

这部分需要显式约束，否则 retry / resume / reused member 会变得不确定。

建议 v1 采用以下规则：

1. orchestrator 为每个成员生成确定性的 `bootstrap_fingerprint`
   - 输入至少包括：`group_id`、`nickname`、`resolved_profile`、shared prefix 内容、runtime metadata block、`roster_version`
2. member runtime 记录：
   - `bootstrapped_subscriber_id`
   - `bootstrap_fingerprint`
   - `bootstrap_status`
3. 若当前 member 满足以下条件，则跳过再次注入：
   - `bootstrap_status=applied`
   - `bootstrapped_subscriber_id` 等于当前 `subscriber_id`
   - `bootstrap_fingerprint` 与本次计算结果一致
4. 若 `subscriber_id` 变化，视为新会话，允许重新注入
5. 若 fingerprint 变化但 `subscriber_id` 未变化，v1 不做热更新重注入；应要求重启该 member 或整组重跑

对 reused / resumed 情况再补一条明确规则：

6. reused member 只有在“同一 `group_id` 且 fingerprint 一致且已 bootstrap”时才允许复用；否则 v1 应视为不安全复用并让 group launch 失败，而不是把新的 group prompt 再注入到一个未知上下文会话里
7. daemon resume 时，如果 runtime 中已经记录为 `applied` 且 fingerprint 未变，则只恢复状态，不重复注入

### 9.3 运行态补充字段

为了让排障和状态查询可见，建议在 `.ufoo/groups/<group-id>.json` 的 member 级别增加：

- `prompt_profile`
- `resolved_profile`
- `profile_source`
- `bootstrap_status` (`pending|applied|failed|skipped`)
- `bootstrap_attempted_at`
- `bootstrap_error`

在 group 级别建议额外保留：

- `roster_version`
- `members[*].role`
- `members[*].report_to`
- `members[*].accept_from`
- `members[*].bootstrapped_subscriber_id`
- `members[*].bootstrap_fingerprint`

### 9.4 dry-run 输出

`ufoo group run <alias> --dry-run` 应该能直接显示：

- 每个成员最终使用的 `resolved_profile`
- 每个成员给人看的 `display_name`
- profile 来自 builtin / global / project 哪一层
- 是否需要 bootstrap inject
- 将使用哪种注入策略（`ucode-bootstrap-file` / `post-launch-inject`）
- 每个成员将看到的 roster 摘要
- 若当前已有同昵称 active member，是否会复用或因 fingerprint 不一致而失败

---

## 十、后续实现计划

这一部分是后续代码实现的计划，不在本轮执行。

## Phase 0: 契约冻结与兼容策略

目标：

- 明确 `prompt_profile` registry 的存储格式和解析优先级
- 明确旧 profile 名称的兼容策略
- 明确 Codex / Claude / ucode 三类 agent 的 bootstrap 注入方式

验收：

- 文档层面确认：
  - 是否保留旧 profile 名称
  - 是否使用 alias
  - 注入失败是否触发 rollback
  - alias 冲突是否直接报错
  - reused / resumed member 的 bootstrap 判定规则

## Phase 1: Prompt registry + validation

目标：

- 在 `ufoo` 中引入内置 `prompt_profile` registry
- 支持 builtin / global / project 覆盖
- 扩展 `group template validate`，让 `prompt_profile` 变成可校验字段

建议落点：

- `src/orchestration/groups/promptProfiles.js`
- `templates/groups/*.json` 继续只存引用，不存长 prompt 正文

建议原则：

- v1 只做整条 profile 覆盖，不做字段级 merge
- 旧模板引用的 profile 名称必须仍然能被解析
- 无效 `prompt_profile` 在 validate 阶段直接失败

验收：

- 当前 builtin templates 在不修改内容的情况下仍能 `validate` 成功
- 拼写错误的 `prompt_profile` 会返回明确错误路径
- alias 与 `id` / alias 冲突时会返回明确错误

## Phase 2: Shared role prefix composer

目标：

- 把“ufoo group 协作规则”抽成公共前缀
- 统一生成最终 bootstrap prompt

建议原则：

- 共享前缀不写进各 profile 正文
- 最终 prompt 组合顺序固定：shared prefix -> profile prompt -> runtime metadata
- 组合结果应可被 dry-run / debug 输出

验收：

- 任一成员都能输出可检查的最终 bootstrap 文本
- 同一 profile 在不同 group 成员上只因 metadata block 不同而变化

## Phase 3: Group launch 注入

目标：

- group 启动 agent 时，将 `prompt_profile` 解析成 startup prompt
- 对 `codex/claude` 采用 post-launch bootstrap inject
- 对 `ucode` 复用现有 bootstrap/system prompt 路径

建议原则：

- profile 注入只做一次
- 保留 group metadata：group_id / nickname / role / profile
- 不污染普通非-group agent 会话
- bootstrap 失败等价于 launch 失败，需要 rollback
- reused / resumed 情况下，必须先做 fingerprint 判定，再决定 skip / fail / fresh bootstrap

验收：

- `dry-run` 能显示每个成员的注入策略
- 实际运行中，bootstrap 成功后 member 状态为 `bootstrap_status=applied`
- 若 Codex / Claude 注入失败，group 状态为 `failed` 且已启动成员被回滚
- reused member 若 fingerprint 不一致，会明确失败而不是被静默重注入
- daemon resume 不会对同一 subscriber 重复 bootstrap

## Phase 4: Builtin templates

目标：

- 内置三个模板：
  - `product-discovery`
  - `build-lane`
  - `verify-ship`

建议原则：

- 新模板继续包含 `accept_from`、`report_to`、`edges`
- 不替换掉现有 builtin templates，先并存
- 需要时再单独迁移旧模板到新 profile 命名

验收：

- `group template list/show/validate` 能看到三个新增模板
- 图渲染和后续 soft policy 不会因为模板字段缺失而失效

## Phase 5: 文档与示例

目标：

- README 增加 group preset 说明
- `ufoo group template show <alias>` 能看到 profile 引用
- 提供 example workflow

验收：

- 文档明确区分“profile registry”和“group template”
- 文档写清旧 profile 的兼容状态与新模板的推荐用法
- CLI / 文档默认优先展示 `display_name`，需要时再附带 `(id: ...)`

---

## 十一、推荐的第一版实施范围

为了避免一下子把系统做重，建议第一版只做：

1. 先做 8 个新 role profiles，加上旧 profile 的兼容保留
2. 先把 `prompt_profile` 变成可校验、可 dry-run 解析的正式契约
3. 先支持 group launch 时的一次性 bootstrap 注入
4. 先不做复杂的 profile 继承和字段级 merge
5. 先不把 gstack 那套 AskUserQuestion / Completeness / Contributor Mode 搬进来
6. 先不做 profile 级 DSL，只接受固定结构的 profile entry

---

## 十二、最终建议

`ufoo` 应该借鉴 `gstack` 的不是“技能文风”，而是它对角色边界和交付责任的定义方式。

正确做法不是：

- 直接复制 `office-hours`
- 直接复制 `plan-ceo-review`
- 直接复制 `ship`

正确做法是：

- 抽取角色能力内核
- 去品牌化
- 去单体 skill 依赖
- 增强 group 协作边界
- 用 `prompt_profile` 作为组合件
- 先把 registry / validation / bootstrap 这三层走通，再落模板物料

如果继续下一轮，建议顺序是：

1. 先冻结 profile registry 和兼容策略
2. 再让 `group template validate` 真正校验 `prompt_profile`
3. 再接 group launch 的 bootstrap 注入链路
4. 最后落三个 builtin group template，并补 README / 示例
