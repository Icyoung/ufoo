# ufoo Documentation Index

This directory keeps current architecture notes at the top level and completed
planning material in `docs/archive/`.

## Active References

| Document | Status | Purpose |
|---|---|---|
| `source-structure.md` | current | Source package map and proposed clearer `src/` structure. |
| `agent-prompts-and-tools.md` | current | Agent bodies, prompts, bootstrap text, prompt profiles, and tool definitions. |
| `agent-prompts-and-tools.zh.md` | current | Chinese prompt reference with original prompt text and Chinese translations. |
| `agent-design-audit-and-optimization-plan.md` | confirmed findings + backlog | Agent-design audit with code-confirmed prompt/runtime findings and phased optimization plan. |
| `daemon-mcp-integration-plan.md` | initial implementation + backlog | Local global MCP bridge shape, current `ufoo mcp` surface, and remaining convergence work. |
| `bus-delivery-queue-refactor-plan.md` | design proposal | Refactor plan for one daemon-owned durable bus delivery queue and scheduler. |
| `delivery-queue-developer-guide.md` | current | Developer guide for writing producers and consumers on the unified bus delivery queue. |
| `ufoo-agent-api-loop-plan.md` | backlog | API-loop follow-up plan after the initial implementation. |
| `ufoo-group-role-presets-plan.md` | implemented with gaps | Role preset work that still has documented gaps to close. |
| `ufoo-prompt-envelope-and-tags-plan.md` | needs audit | Prompt envelope/tag core exists, but timeline/history details need a final implementation check. |
| `implementation_plan.md` | stale/unverified | Older chat log copy plan; implementation was not found during this cleanup. |
| `ucode-context-manager-plan.md` | **complete** (P3 optional) | Native `ucode` Context Manager：已落地能力、延后项、env/验证。 |
| `codebase-review-2026.md` | reference | Historical review notes. |
| `ufoo-docs-implementation-audit.md` | reference | Audit used to classify plan documents before this archive pass. |

## Archived Completed Plans

The following documents describe work that has landed or has been absorbed by
newer implementation/docs, so they are kept as historical context only:

- `archive/agent-group-orchestration-requirements.md`
- `archive/agent-group-orchestration-technical-plan.md`
- `archive/agent-to-ufoo-control-plane.md`
- `archive/global-chat-multi-project-technical-plan.md`
- `archive/internal-agent-activity-state-plan.md`
- `archive/nickname-scoping-plan.md`
- `archive/ufoo-design-role-presets-from-gstack.md`
- `archive/ufoo-shared-memory-plan.md`

Pre-existing historical archive documents remain in `docs/archive/`.

## Policy

- Keep top-level docs for active architecture, current source-of-truth
  references, backlog plans, and plans with known gaps.
- Move plan, requirements, and design docs to `docs/archive/` after the
  implementation is complete or the content has been absorbed by newer docs.
- When changing prompts or tools, update `agent-prompts-and-tools.md`.
- When moving source packages, update `source-structure.md`.
