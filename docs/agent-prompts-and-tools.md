# Agent Prompts And Tool Calls Inventory

This document maps the current agent bodies, prompt sources, bootstrap flows,
system prompts, tool definitions, and tool-call execution paths.

The complete bilingual prompt text reference is
`docs/agent-prompts-and-tools.zh.md`. This file is the source map and execution
inventory; the Chinese file contains the original prompt templates plus Chinese
translations.

Scope:

- Included: fixed prompt templates, system prompts, bootstrap prompts, prompt
  envelopes, role profile prompts, task-decomposition prompts, skill-injection
  wrappers, and tool descriptions/schemas that can be sent to a model or agent.
- Excluded: tests, UI command help, status/log strings, user-authored task
  content, and external `SKILL.md` bodies except for the wrapper text that
  injects a selected skill into the prompt.

## Agent Bodies

| Agent/runtime | Main source | What it is |
|---|---|---|
| `ucode` native agent | `src/code/agent.js`, `src/code/nativeRunner.js` | Native coding-agent CLI/TUI. Builds a system prompt, calls OpenAI-compatible or Anthropic-compatible APIs, executes core file/shell tools, persists session messages. |
| `ufoo-agent` controller | `src/agents/controller/ufooAgent.js`, `src/agents/controller/loopRuntime.js`, `src/agents/controller/controllerToolExecutor.js` | Headless router/controller used by daemon and chat. Returns JSON route/dispatch/ops payloads, can run a limited controller loop with tool calls. |
| External CLI agents | `src/agents/launch/launcher.js`, `src/agents/launch/ptyRunner.js` | Wrap Claude Code, Codex CLI, Antigravity, and ucode in terminal/PTY sessions with bus identity and startup bootstrap. |
| Internal agents | `src/agents/internal/internalRunner.js` | Embedded SDK-backed runner for internal mode. Uses Codex/Claude thread providers and bus queue injection. |
| Claude thread provider | `src/agents/providers/claudeThreadProvider.js` | Claude Agent SDK / Anthropic messages seam, system blocks, prompt cache, tool descriptor normalization. |
| Codex thread provider | `src/agents/providers/codexThreadProvider.js` | OpenAI Codex SDK seam, thread start/resume, streamed event normalization. |
| Upstream direct transport | `src/agents/providers/upstreamTransport.js` | Direct OpenAI chat, Anthropic messages, and Codex Responses request builders for `ufoo-agent`. |

## Prompt Source Of Truth

| Prompt area | Source files | Active use |
|---|---|---|
| Native `ucode` system prompt | `src/agents/prompts/native/index.js`, `src/agents/prompts/native/*.js` | Active. `buildPromptContext()` is imported directly by `src/code/agent.js`. |
| `ucode` bundled baseline append | `src/code/UCODE_PROMPT.md` | Used as the default `UFOO_UCODE_PROMPT_FILE` append when `ucode` is launched through the ufoo agent wrapper; modular JS under `src/agents/prompts/native/` remains the primary system prompt. |
| Native `ucode` tool descriptions | `src/agents/prompts/native/toolDescriptions/*.js` | Active. Used directly by `src/code/nativeRunner.js` to build OpenAI/Anthropic tool specs. |
| Default CLI startup bootstrap | `src/agents/prompts/defaultBootstrap.js` | Active for external Claude/Codex/Agy and internal runner bootstraps. |
| Shared ufoo protocol | `src/agents/prompts/groupBootstrap.js` (`SHARED_UFOO_PROTOCOL`) | Active. Included in default bootstrap, group bootstrap, and solo bootstrap. |
| Group and solo bootstrap | `src/agents/prompts/groupBootstrap.js`, `src/runtime/daemon/groupOrchestrator.js`, `src/runtime/daemon/soloBootstrap.js` | Active. Composes shared prefix + profile prompt + runtime metadata. |
| Built-in role profiles | `src/agents/prompts/promptProfiles.js` | Active. Used by group templates, `/solo`, role assignment, and launch bootstrap. |
| Group templates | `templates/groups/*.json` | Active. Define roster, prompt profiles, dependencies, and handoff graph. |
| Bus/manual prompt envelope | `src/coordination/bus/promptEnvelope.js`, `src/coordination/bus/envelope.js` | Active. Wraps injected messages as manual/bus envelopes with sender/target tags. |
| `ufoo-agent` router prompts | `src/agents/controller/ufooAgent.js` | Active. `buildSystemPrompt()` and `buildRouteAgentSystemPrompt()` define controller JSON contracts. |
| Controller loop continuation prompt | `src/agents/controller/loopRuntime.js` | Active when loop runtime is enabled. Adds previous draft, tool results, and loop state. |
| Project instructions template | `modules/AGENTS.template.md`, root `AGENTS.md` | Active for initialized projects and this repo. |

## Complete Prompt Coverage Matrix

| Prompt/template id | Source | Sent by | Notes |
|---|---|---|---|
| `ucode.identity` | `src/agents/prompts/native/identity.js` | `src/code/agent.js` -> native provider | Static `ucode` identity and security posture. |
| `ucode.system` | `src/agents/prompts/native/system.js` | `src/code/agent.js` -> native provider | General tool-use and prompt-injection rules. |
| `ucode.tasks` | `src/agents/prompts/native/tasks.js` | `src/code/agent.js` -> native provider | Coding task workflow rules. |
| `ucode.actions` | `src/agents/prompts/native/actions.js` | `src/code/agent.js` -> native provider | Reversibility, destructive actions, and git caution. |
| `ucode.safety` | `src/agents/prompts/native/safety.js` | `src/code/agent.js` -> native provider | Secrets, malware, and workspace boundary rules. |
| `ucode.efficiency` | `src/agents/prompts/native/efficiency.js` | `src/code/agent.js` -> native provider | Concise output rules. |
| `ucode.ufooIntegration` | `src/agents/prompts/native/ufoo.js` | `src/code/agent.js` -> native provider | ufoo bus/context/memory/report protocol for `ucode`. |
| `ucode.environment` | `src/agents/prompts/native/environment.js` | `src/code/agent.js` -> native provider | Dynamic cwd/git/platform/shell/date/provider/model block. |
| `ucode.coreBaselineAppend` | `src/code/UCODE_PROMPT.md` | `src/code/launcher/ucode.js` -> `UFOO_UCODE_PROMPT_FILE` -> `src/code/agent.js` | Bundled append prompt for wrapper-launched `ucode`. |
| `ucode.skillsDiscovery` | `src/code/skills/render.js` | `src/agents/prompts/native/index.js` | Dynamic list of enabled skills and usage rules. |
| `ucode.selectedSkillWrapper` | `src/code/skills/injection.js` | `src/code/agent.js` | `<skill>` wrapper around selected `SKILL.md` bodies. |
| `ucode.analysisRequirements` | `src/code/agent.js` | `runNaturalLanguageTask()` | Appended to analysis/review/audit/codebase tasks. |
| `ucode.preflightSnapshot` | `src/code/agent.js` | `runNaturalLanguageTask()` | `AGENTS.md`/README/package or `ls -la` evidence block. |
| `ucode.decompose.identify` | `src/code/taskDecomposer.js` | `runDecomposedTask()` | Bug-fix step 1 prompt. |
| `ucode.decompose.locate` | `src/code/taskDecomposer.js` | `runDecomposedTask()` | Bug-fix step 2 prompt. |
| `ucode.decompose.fix` | `src/code/taskDecomposer.js` | `runDecomposedTask()` | Bug-fix step 3 prompt. |
| `ucode.decompose.verify` | `src/code/taskDecomposer.js` | `runDecomposedTask()` | Bug-fix step 4 prompt. |
| `ucode.tool.read` | `src/agents/prompts/native/toolDescriptions/read.js` | `src/code/nativeRunner.js` | Native `read` tool description and schema. |
| `ucode.tool.write` | `src/agents/prompts/native/toolDescriptions/write.js` | `src/code/nativeRunner.js` | Native `write` tool description and schema. |
| `ucode.tool.edit` | `src/agents/prompts/native/toolDescriptions/edit.js` | `src/code/nativeRunner.js` | Native `edit` tool description and schema. |
| `ucode.tool.bash` | `src/agents/prompts/native/toolDescriptions/bash.js` | `src/code/nativeRunner.js` | Native `bash` tool description and schema. |
| `bootstrap.defaultStartup` | `src/agents/prompts/defaultBootstrap.js` | external launchers, PTY runner, internal runner | Default startup protocol for Claude/Codex/Agy/ucode. |
| `bootstrap.teamActivity` | `src/coordination/history/inputTimeline.js` | default startup bootstrap | Recent bus/manual prompts appended to startup bootstrap when available. |
| `bootstrap.group.sharedProtocol` | `src/agents/prompts/groupBootstrap.js` | default, group, solo bootstrap | `SHARED_UFOO_PROTOCOL`. |
| `bootstrap.group.sharedPrefix` | `src/agents/prompts/groupBootstrap.js` | group orchestrator | `SHARED_GROUP_PREFIX`. |
| `bootstrap.solo.sharedPrefix` | `src/agents/prompts/groupBootstrap.js` | solo assignment | `SOLO_AGENT_PREFIX`. |
| `bootstrap.runtimeMetadata` | `src/agents/prompts/groupBootstrap.js` | group/solo bootstrap | Runtime metadata JSON block. |
| `profile.discovery-facilitator` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.scope-challenger` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.system-architect` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.implementation-lead` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.design-system-consultant` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.ui-plan-critic` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.frontend-refiner` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.design-critic` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.review-critic` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.qa-driver` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.debug-investigator` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.release-coordinator` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.task-breakdown` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.research-scan` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.rapid-prototype` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `profile.pmo-coordinator` | `src/agents/prompts/promptProfiles.js` | group/solo bootstrap | Built-in role prompt. |
| `ufooAgent.globalRouter` | `src/agents/controller/ufooAgent.js` | `runUfooAgent()` | `ufoo chat -g` project router system prompt. |
| `ufooAgent.mainRouter` | `src/agents/controller/ufooAgent.js` | `runUfooAgent()` | Project-local router system prompt. |
| `ufooAgent.loopRouter` | `src/agents/controller/ufooAgent.js` | controller loop runtime | Limited-loop router system prompt with `tool_call`. |
| `ufooAgent.gateRouter` | `src/agents/controller/ufooAgent.js` | `runUfooRouteAgent()` | Front-door pure-delegation router prompt. |
| `ufooAgent.historyPrompt` | `src/agents/controller/ufooAgent.js` | router calls | Recent conversation prefix. |
| `ufooAgent.memoryPrefix` | `src/agents/controller/ufooAgent.js`, `src/coordination/memory` | router calls | Dynamic shared memory prefix appended to router system prompt. |
| `controller.privateReports` | `src/runtime/daemon/promptRequest.js` | prompt request path | Private report and routing metadata prompt extension. |
| `controller.loopContinuation` | `src/agents/controller/loopRuntime.js` | limited loop runtime | Continuation prompt after tool results. |
| `bus.promptEnvelope` | `src/coordination/bus/promptEnvelope.js`, `src/coordination/bus/envelope.js` | PTY/internal injection | `[manual]` / `[ufoo]` prompt envelope. |
| `project.agentsTemplate` | `modules/AGENTS.template.md` | `ufoo init` | Project instruction template inserted into AGENTS/CLAUDE files. |

The old prompt compatibility paths have been removed. Import prompt builders
from `src/agents/prompts/` and `src/agents/prompts/native/`.

## Native `ucode` System Prompt

Builder: `src/agents/prompts/native/index.js`.

Priority:

1. `overrideSystemPrompt` replaces everything.
2. Default modular sections are assembled.
3. `appendSystemPrompt` is appended last.

Static sections:

| Section | File | Purpose |
|---|---|---|
| identity | `src/agents/prompts/native/identity.js` | Defines `ucode`, objectives, and security posture. |
| system | `src/agents/prompts/native/system.js` | General tool-use and output rules. |
| tasks | `src/agents/prompts/native/tasks.js` | Coding-task behavior and scope discipline. |
| actions | `src/agents/prompts/native/actions.js` | Reversibility, blast radius, and git/destructive-action caution. |
| safety | `src/agents/prompts/native/safety.js` | Secrets, harmful code, and workspace boundary rules. |
| efficiency | `src/agents/prompts/native/efficiency.js` | Concise output and milestone status updates. |

Dynamic sections:

| Section | File | Cache behavior |
|---|---|---|
| ufoo integration | `src/agents/prompts/native/ufoo.js` | Cached via `systemPromptSection()`. |
| environment | `src/agents/prompts/native/environment.js` | Cached via `systemPromptSection()`. Includes cwd, git status, platform, shell, date, provider, model. |
| skills | `src/code/skills/*` via `src/agents/prompts/native/index.js` | Uncached. Lists available ucode skills for the workspace. |

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separates cacheable and dynamic content for
future prompt-cache aware providers.

## Native `ucode` Task Flow

Main path: `src/code/agent.js`.

1. Resolve provider/model from env and config.
2. Build task prompt and optional analysis preflight context.
3. Inject matching skills with `src/code/skills/`.
4. Compose system context from persisted context and preflight snapshot.
5. Call `runNativeAgentTask()` from `src/code/nativeRunner.js`.
6. Stream text/tool events to the TUI if callbacks are provided.
7. Persist session messages through `src/code/sessionStore.js`.

Bug-like tasks may route through `src/code/taskDecomposer.js` before the native
provider call.

## Default Startup Bootstrap

Builder: `src/agents/prompts/defaultBootstrap.js`.

`buildDefaultStartupBootstrapPrompt()` creates:

1. Session bootstrap header for Claude, Codex, ucode, Agy, or generic agent.
2. Silent adoption instruction.
3. `SHARED_UFOO_PROTOCOL` from `src/agents/prompts/groupBootstrap.js`.
4. Optional team activity from `src/coordination/history/inputTimeline.js`.

Injection strategy:

| Agent type | Strategy |
|---|---|
| Claude Code external | Merge into `--append-system-prompt` file, existing `--system-prompt`, or a generated bootstrap file. |
| Codex external | Merge with final positional prompt when present; otherwise use `UFOO_STARTUP_BOOTSTRAP_TEXT` and append startup prompt in PTY runner. |
| Agy external | Merge/prepend `-i` or `--prompt-interactive`. |
| Internal Claude/Codex | `src/agents/internal/internalRunner.js` consumes the same bootstrap text before bus prompt messages. |

`UFOO_SKIP_DEFAULT_BOOTSTRAP=1` skips default startup bootstrap. Help/version/meta
commands also skip it.

## Group And Solo Bootstrap

Source: `src/agents/prompts/groupBootstrap.js`.

Shared constants:

| Constant | Used by | Purpose |
|---|---|---|
| `SHARED_UFOO_PROTOCOL` | default, group, solo bootstrap | Coordination protocol for decisions, bus, and reports. |
| `SHARED_GROUP_PREFIX` | group bootstrap | Multi-agent group operating rules plus shared protocol. |
| `SOLO_AGENT_PREFIX` | solo bootstrap | Role-specialized solo-agent operating rules plus shared protocol. |

Composition:

```text
shared prefix
  + prompt profile prompt
  + Runtime metadata JSON
```

Metadata builders:

- `buildGroupPromptMetadata()` records group id, roster version, self nickname,
  role, prompt profile, dependencies, upstream/downstream handoff graph.
- `buildSoloPromptMetadata()` records nickname, agent type, prompt profile, and
  profile source.

Group orchestration source: `src/runtime/daemon/groupOrchestrator.js`.
Solo assignment source: `src/runtime/daemon/soloBootstrap.js`.

## Built-In Prompt Profiles

Source: `src/agents/prompts/promptProfiles.js`.

| Profile | Alias | Summary |
|---|---|---|
| `debug-investigator` | `debug` | Identify root cause before proposing a fix. |
| `design-critic` | | Audit interface clarity, interaction quality, and polish opportunities. |
| `design-system-consultant` | `design-consultation` | Define product visual system before implementation or polish. |
| `discovery-facilitator` | `office-hours` | Clarify the real problem before committing to a solution. |
| `frontend-refiner` | | Apply focused UI and interaction refinements. |
| `implementation-lead` | `code-implement` | Turn an approved plan into working code with minimal churn. |
| `pmo-coordinator` | `pmo` | Coordinate builders, progress, dependencies, and cadence. |
| `qa-driver` | `qa` | Validate features from a user-flow perspective. |
| `rapid-prototype` | | Build the smallest testable implementation that answers the question. |
| `release-coordinator` | `ship` | Move a reviewed change toward merge or release. |
| `research-scan` | | Collect references quickly and summarize confidence. |
| `review-critic` | `review` | Find behavioral bugs, correctness gaps, and missing tests. |
| `scope-challenger` | `plan-ceo-review` | Stress-test ambition, sharpness, and leverage. |
| `system-architect` | `architecture-review`, `plan-eng-review` | Convert scope into a defensible technical plan. |
| `task-breakdown` | | Break scoped work into execution-ready slices. |
| `ui-plan-critic` | `plan-design-review` | Review UI/UX plans before implementation. |

Custom project profiles can live under `.ufoo/prompt-profiles/`; global custom
profiles can live under `~/.ufoo/prompt-profiles/`.

## Group Templates

Source: `templates/groups/*.json`.

| Template | Agents and profiles |
|---|---|
| `build-lane` | `architect:system-architect`, `builder:implementation-lead`, `reviewer:review-critic`, `qa:qa-driver` |
| `build-ultra` | `pmo:pmo-coordinator`, `builder-1..4:implementation-lead`, `reviewer:review-critic` |
| `design-system` | `consultant:design-system-consultant`, `challenger:scope-challenger`, `architect:system-architect` |
| `product-discovery` | `facilitator:discovery-facilitator`, `challenger:scope-challenger`, `architect:system-architect` |
| `ui-plan-review` | `planner:ui-plan-critic`, `challenger:scope-challenger`, `architect:system-architect` |
| `ui-polish` | `designer:design-critic`, `refiner:frontend-refiner`, `qa:qa-driver` |
| `verify-ship` | `qa:qa-driver`, `debugger:debug-investigator`, `release:release-coordinator` |

Validation is in `src/orchestration/groups/validateTemplate.js` and
`src/orchestration/groups/templateValidation.js`.

## Bus And Manual Prompt Envelopes

Source: `src/coordination/bus/promptEnvelope.js` and
`src/coordination/bus/envelope.js`.

Injected prompts are wrapped unless the event requests raw injection. The
envelope distinguishes:

- `manual`: chat/manual source such as `chat-direct`, `chat-internal-agent-view`,
  `chat-manual`, or `manual`.
- `bus`: peer agent message.

The envelope includes publisher id/nickname, target id/nickname, message tags,
task id, and the message body. PTY and internal runners call
`buildPromptInjectionText()` before writing prompt-facing text into the agent.

## `ufoo-agent` Router Prompts

Source: `src/agents/controller/ufooAgent.js`.

Prompt builders:

| Builder | Mode | Contract |
|---|---|---|
| `buildSystemPrompt(context, { routingMode: "global-router" })` | Global chat controller | Return JSON with `reply`, optional `project_route`, empty `dispatch`, empty `ops`. |
| `buildSystemPrompt(context, { loopRuntime })` | Limited loop router | Return JSON with `reply`, `done`, empty-or-filled `dispatch`/`ops`, optional `tool_call`. |
| `buildSystemPrompt(context, default)` | Project main router | Return JSON with `reply`, `dispatch`, `ops`, optional `disambiguate`, optional `upgrade_to_loop_router`. |
| `buildRouteAgentSystemPrompt()` | Gate router | Return JSON with `decision`, `target`, `message`, `confidence`, `reason`, `injection_mode`. |

Important router rules:

- No markdown or extra text; router output must be valid JSON.
- `assistant_call` is removed and must not be emitted.
- Existing agent prompt history is a primary continuity signal.
- New launched workers must receive a dispatched task; no launch-only ops for
  delegated work.
- Global router does not dispatch directly to project-local agents.

## Controller Loop Tool Calls

Source: `src/agents/controller/loopRuntime.js` and
`src/agents/controller/controllerToolExecutor.js`.

The loop prompt advertises:

- `dispatch_message`
- `ack_bus`
- `launch_agent`

The executor also supports any shared registry tool allowed for controller
callers. Tool-call arguments may be JSON strings or objects. Results are added
to the continuation prompt by `buildLoopContinuationPrompt()` with:

- original prompt
- previous draft reply
- controller loop state JSON
- tool results JSON

Loop limits are controlled by:

- `UFOO_AGENT_RUNTIME_MODE=loop` or `UFOO_AGENT_ENABLE_LOOP=1`
- `UFOO_AGENT_LOOP_MAX_ROUNDS`
- `UFOO_AGENT_LOOP_MAX_TOOL_CALLS`
- `UFOO_AGENT_LOOP_MAX_TOOL_ERRORS`
- `UFOO_AGENT_LOOP_MAX_PROMPT_CHARS`

## Native `ucode` Tools

Sources: `src/code/tools/*.js`, `src/code/dispatch.js`,
`src/code/nativeRunner.js`,
`src/agents/prompts/native/toolDescriptions/*.js`.

| Tool | Required args | Optional args | Implementation |
|---|---|---|---|
| `read` | `path` | `startLine`, `endLine`, `maxBytes` | Reads workspace-confined text files with line slicing and byte cap. |
| `write` | `path`, `content` | `append`, `mode` | Writes or appends inside workspace, creating parent dirs. |
| `edit` | `path`, `find`, `replace` | `all` | Exact string replacement in an existing file. |
| `bash` | `command` | `timeoutMs` | Runs one shell command in workspace with timeout and output capture. |

Tool specs:

- OpenAI-like chat requests use `tools: [{ type: "function", function: ... }]`.
- Anthropic requests use `{ name, description, input_schema }`.
- Tool descriptions live in `src/agents/prompts/native/toolDescriptions/`.
- Tool budget defaults are `100` calls and `5` errors; override with
  `UFOO_UCODE_MAX_TOOL_CALLS` and `UFOO_UCODE_MAX_TOOL_ERRORS`.

## Shared Controller/Worker Tools

Sources: `src/tools/schemaFixtures.js`, `src/tools/registry.js`,
`src/tools/tier0/`, `src/tools/tier1/`, `src/tools/tier2/`,
`src/tools/handlers/`.

| Tool | Tier | Callers | Purpose |
|---|---|---|---|
| `read_bus_summary` | `tier0-read` | controller, worker | Read project bus/unread/decisions/report/cron/group summary. |
| `read_prompt_history` | `tier0-read` | controller, worker | Read recent prompt-history summaries for active agents. |
| `read_open_decisions` | `tier0-read` | controller, worker | List open decisions. |
| `list_agents` | `tier0-read` | controller, worker | List active agents with nickname/status/activity metadata. |
| `read_project_registry` | `tier0-read` | controller, worker | Read cross-project runtime registry. |
| `route_agent` | `tier1-coordination` | controller, worker | Pick best agent/nickname for a request. Currently dormant handler. |
| `dispatch_message` | `tier1-coordination` | controller, worker | Send message to target agent, nickname, or broadcast. |
| `ack_bus` | `tier1-coordination` | controller, worker | Ack pending messages for the caller-owned queue. |
| `remember` | `tier1-coordination` | controller, worker | Record durable project memory. |
| `recall` | `tier1-coordination` | controller, worker | Read memory by id or tags. |
| `search_memory` | `tier1-coordination` | controller, worker | Search memory entries. |
| `search_history` | `tier1-coordination` | controller, worker | Search local session history snippets. |
| `edit_memory` | `tier1-coordination` | controller, worker | Edit existing memory entry. |
| `forget` | `tier1-coordination` | controller, worker | Archive memory entry. |
| `launch_agent` | `tier2-orchestration` | controller only | Launch worker agents. |
| `rename_agent` | `tier2-orchestration` | controller only | Rename an agent session. |
| `close_agent` | `tier2-orchestration` | controller only | Close an agent session. |
| `manage_cron` | `tier2-orchestration` | controller only | Create/list/stop controller cron tasks. |

Worker-tier tools are exposed to internal runner descriptors by
`src/agents/internal/internalRunner.js`. The current Codex SDK seam injects descriptors;
live SDK-stream tool execution is still constrained by the provider seam.

## Provider Request Shapes

| Provider path | Source | Prompt placement | Tool placement |
|---|---|---|---|
| OpenAI chat-compatible native `ucode` | `src/code/nativeRunner.js` | `messages` with system/user history | Function tools from native `ucode` tool specs. |
| Anthropic messages native `ucode` | `src/code/nativeRunner.js` | `system` plus `messages` | Anthropic tool specs from native `ucode` tool specs. |
| Direct OpenAI chat for `ufoo-agent` | `src/agents/providers/upstreamTransport.js` | `messages`, with optional system message | Optional `tools` passed through. |
| Direct Anthropic messages for `ufoo-agent` | `src/agents/providers/upstreamTransport.js` | `system` plus `messages` | Optional `tools` passed through. |
| Codex Responses for `ufoo-agent` | `src/agents/providers/upstreamTransport.js` | `instructions` plus `input` messages | No shared tools passed in this request builder today. |
| Claude internal thread | `src/agents/providers/claudeThreadProvider.js` | Cached system blocks and user messages | Normalized `input_schema` tool descriptors. |
| Codex internal thread | `src/agents/providers/codexThreadProvider.js` | Thread `runStreamed(input, opts)` | Descriptors can be attached to turn opts. |

## Update Checklist

When changing prompts or tools:

1. Update the source file.
2. Update this inventory.
3. Add or update unit tests near the source package.
4. For router prompt changes, test `ufoo-agent` routing paths and JSON parsing.
5. For tool schema changes, update `src/tools/schemaFixtures.js`, registry
   tests, and handler tests together.
6. For native `ucode` tool changes, update `src/code/nativeRunner.js` specs and
   `src/code/tools/*` tests together.
