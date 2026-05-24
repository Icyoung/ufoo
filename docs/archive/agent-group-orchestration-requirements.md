# ufoo Agent Group Orchestration Requirements (Final)

Date: 2026-02-23
Status: implemented
Implementation plan: `docs/agent-group-orchestration-technical-plan.md`
Related decisions:
- `.ufoo/context/decisions/0225-codex-4-template-driven-agent-orchestration-groups-for-multi-agent-launch-and-routing.md`
- `.ufoo/context/decisions/0226-ucode-5-architecture-review-agent-group-orchestration-template-risks-and-suggestions.md`
- `.ufoo/context/decisions/0227-codex-4-adopt-0226-review-and-phase-agent-group-implementation-with-send-hooks-and-transactional-orchestrator.md`

## Implementation Audit (2026-04-26)

The v1 group orchestration requirements are implemented: template registry and
validation, CLI/chat command surfaces, group runtime state, transactional launch
with rollback, stop/status/diagram support, prompt profile integration, and the
warn-only `preSendHooks` / `accept_from` soft routing policy in the bus send
path.

## 1. Goal
Provide template-driven multi-agent orchestration in ufoo:
- Built-in and user-defined JSON templates
- One command/chat action to launch an agent group
- Group topology visualization
- Future-ready routing policy enforcement (v1 soft, v2 hard)

## 2. Scope
### In Scope (v1)
- Template registry and loading (built-in + project + global user templates)
- Template validation (lightweight internal validator, no heavy schema dependency)
- Group runtime orchestration with rollback on partial failure
- CLI commands for template/group lifecycle
- ASCII diagram rendering
- Soft routing policy checks (warn-only)

### Out of Scope (v1)
- Hard bus ACL enforcement
- Complex workflow DAG scheduler beyond startup ordering/depends_on
- Cross-project shared group runtime management

## 3. Template Contract (JSON)
Minimal required structure:

```json
{
  "schema_version": 1,
  "template": {
    "id": "software-dev-basic",
    "alias": "dev-basic",
    "name": "Software Dev Basic"
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
      "role": "system architect",
      "prompt_profile": "architecture-review",
      "accept_from": ["pm", "backend"],
      "report_to": ["pm"],
      "startup_order": 1,
      "depends_on": []
    }
  ],
  "edges": [
    { "from": "pm", "to": "architect", "kind": "task" }
  ]
}
```

Validation rules (v1):
- `agents` must be non-empty
- `agents[].nickname` must be unique
- `agents[].type` in `{codex, claude, ucode}`
- `edges[].from/to` must reference existing nicknames
- `depends_on`, `accept_from`, `report_to` references must be resolvable
- `startup_order` must be valid and sortable

## 4. Command Surface
New command group:
- `ufoo group templates list`
- `ufoo group template show <alias>`
- `ufoo group template validate <alias|path>`
- `ufoo group template new <alias> --from <builtin>`
- `ufoo group run <alias> [--instance <name>] [--dry-run]`
- `ufoo group status [instance]`
- `ufoo group diagram <alias|instance> [--ascii|--mermaid]`
- `ufoo group stop <instance>`

Chat side mirrors these operations with `/group ...` commands.

## 5. Storage Layout
- Built-in templates: `templates/groups/*.json`
- Project user templates: `.ufoo/templates/groups/*.json`
- Global user templates: `~/.ufoo/templates/groups/*.json`
- Group runtime state: `.ufoo/groups/<group-id>.json`

Template resolution priority:
1) Project template
2) Global user template
3) Built-in template

## 6. Runtime Behavior
- Compile template into launch plan by `startup_order` + `depends_on`
- Launch via existing daemon single-agent launch pipeline
- Persist runtime mapping:
  - group id
  - template alias/version
  - launched subscriber ids
  - per-agent status
- On partial launch failure:
  - rollback previously launched agents (close in reverse order)
  - write group state as `failed`

## 7. Bus Policy Strategy
### v1
- Add `preSendHooks` extension point in `src/bus/message.js` send path
- Hook only emits warnings (no block)

### v2
- Reuse same hook position for hard ACL (`accept_from`/policy enforcement)
- Reject disallowed routes before queue append

## 8. Required Code Changes
- New: `src/group/validateTemplate.js`
- New: `src/daemon/groupOrchestrator.js`
- New: `src/group/templates.js`
- New: `src/group/diagram.js`
- Extend: `src/shared/eventContract.js` (group IPC types)
- Extend: daemon ops/handlers for group launch/stop/status
- Extend: `src/cli.js` and chat command executor
- Extend: daemon status payload to include group runtime summary

## 9. Test Requirements
1. Group rollback on partial failure:
- Inject launch failure at Nth agent
- Assert prior launched agents are closed
- Assert group state file is `failed`

2. Template validation boundaries:
- empty agents
- duplicate nicknames
- unresolved edge references
- invalid type
- cyclic/invalid depends_on
- invalid startup_order

3. Bus preSendHook behavior:
- v1 warn-only still delivers message
- v2 enforcement blocks message and pending queue is unchanged

## 10. Delivery Phases
Phase A: validator + template loader  
Phase B: transactional orchestrator + group runtime persistence  
Phase C: CLI/chat command surface + status integration  
Phase D: diagram renderer  
Phase E: preSendHooks warn-only (v1 complete), hard ACL in v2
