# ufoo Docs Implementation Audit

Date: 2026-04-26
Status: reference-material

This document records the current implementation status of the planning and
design documents under `docs/`. It is an audit index, not a replacement for the
source plans.

Current top-level/archived placement is tracked in `docs/README.md`. Some
sections below preserve the original audit grouping from 2026-04-26; completed
plan documents may now live under `docs/archive/`.

## Summary

Not every document in `docs/` is simply "implemented" or "obsolete".

Current categories:

- Active / not fully implemented
- Implemented / mostly implemented plans
- Historical / obsolete
- Partially absorbed reference material

Markdown documentation under `docs/` is intended to be tracked. Non-markdown
documentation artifacts can remain ignored.

## Active Or Not Fully Implemented

### `daemon-mcp-integration-plan.md`

Status: active-draft.

Reason:

- The plan describes a daemon-backed MCP control-plane surface.
- Code search did not find an MCP server/tool surface implementation in `src/`,
  `bin/`, or tests.
- Existing wrapper and daemon control-plane code still covers the current
  launcher-centric integration path.

Recommended action:

- Keep as active backlog.
- Add explicit phase gates before implementation starts.

### `ufoo-agent-api-loop-plan.md`

Status: post-v1-backlog.

Implemented:

- Phase 0 / 1a / 1b / 2 / 3 / 4 are substantially landed.
- Codex SDK thread seam, Claude API thread seam, router fast path, limited loop,
  tool registry, loop observability, and helper retirement are present.
- Codex direct-upstream credential bridge, token refresh, transport, and status
  preflight are now present; ufoo-agent direct provider paths no longer fall
  back to CLI on credential errors.

Still not complete:

- `ucode` threadization remains post-v1.
- Some production validation notes remain audit/follow-up work rather than code
  implementation.

Recommended action:

- Keep as active tracking doc, but separate "implemented v1" from "post-v1
  backlog" more aggressively.

### `agent-group-orchestration-requirements.md`

Status: implemented.

Implemented:

- Built-in/project/global template registry.
- Template validation.
- CLI and chat group command surfaces.
- Group runtime state.
- Transactional launch with rollback.
- Stop/status/diagram support.
- Prompt profile integration now exists through later work.
- The v1 soft routing policy hook described as `preSendHooks` / warn-only
  `accept_from` enforcement is present in the bus send path.

Recommended action:

- Keep as implemented protocol documentation.

### `agent-group-orchestration-technical-plan.md`

Status: implemented.

Implemented:

- `src/orchestration/groups/templates.js`
- `src/orchestration/groups/validateTemplate.js`
- `src/orchestration/groups/diagram.js`
- `src/runtime/daemon/groupOrchestrator.js`
- daemon IPC, CLI, and chat command integration
- Phase E send hook / soft policy warning path

Recommended action:

- Mark Phase A-E complete.

### `nickname-scoping-plan.md`

Status: implemented.

Implemented:

- Bus entries can store both `nickname` and `scoped_nickname`.
- Nickname resolution accepts raw nickname and scoped nickname.
- Daemon/status/chat display paths use helpers such as
  `resolveDisplayNickname` / `resolveScopedNickname`.
- Tests cover scoped nickname generation and lookup.
- Group runtime now writes `scoped_nickname`; `runtime_nickname` remains only
  as a legacy read fallback for older runtime files.

Recommended action:

- Keep `runtime_nickname` fallback support until old group runtime files can be
  considered expired or migrated.

## Implemented Or Mostly Implemented

### `agent-to-ufoo-control-plane.md`

Status: implemented.

Evidence:

- Group bootstrap tells workers to use direct handoff for worker-to-worker
  delivery.
- Group bootstrap tells workers to use private `ufoo report` updates for
  ufoo-agent control-plane reporting.
- `promptRequest` injects private reports into controller prompt context as
  observability input.
- Tests cover private report prompt injection and duplicate handoff prevention
  instructions.

Recommended action:

- Add `Status: implemented` and keep as protocol documentation.

### `global-chat-multi-project-technical-plan.md`

Status: implemented.

Evidence:

- `ufoo -g` / global mode exists.
- Project runtime registry exists under `src/runtime/projects/`.
- Global chat uses a two-line dashboard.
- Project rail and projects focus mode exist.
- Transactional daemon hot switch exists.
- Per-project global history and drafts exist.
- CLI/chat project commands exist.
- Tests cover project commands, dashboard rendering, key handling, and daemon
  switch behavior.

Recommended action:

- Add `Status: implemented` and keep as architecture reference.

### `ufoo-group-role-presets-plan.md`

Status: implemented-with-gaps.

Implemented:

- Built-in prompt profile registry.
- Global/project prompt profile override support.
- Alias resolution.
- Template validation against prompt profiles.
- Bootstrap prompt composition.
- Group launch bootstrap injection.
- Bootstrap fingerprint/status tracking.
- Built-in templates such as `build-lane`, `build-ultra`,
  `product-discovery`, `ui-polish`, and `verify-ship`.

Recommended action:

- Mark registry/validation/bootstrap/builtin-template phases as implemented.
- Keep any remaining role-material discussion as reference.

### `ufoo-shared-memory-plan.md`

Status: implemented.

Implemented:

- `.ufoo/memory/` markdown entry storage.
- CLI CRUD/audit/rebuild-index commands.
- Tier 1 memory tools.
- Prefix read path and active memory summary injection.
- `recall` / `search_memory` read tools.
- `search_history`.
- Anti-echo protection.
- Audit and observability hooks.

Not included in v1:

- Optional embedding/M3 retrieval remains future work by design.

Recommended action:

- Keep current implemented status.

## Historical Or Obsolete

### `archive/ufoo-agent-api-loop-phase4-prep.md`

Status: historical.

Reason:

- The document itself says Phase 4 deletions landed on 2026-04-20.
- It should be kept only as the pre-deletion inventory.

Recommended action:

- No implementation action.
- Keep under `docs/archive/` as historical inventory.

### `archive/global-chat-phase-b0-spike-impact.md`

Status: historical.

Reason:

- It records the B0 hot-switch prototype and follow-up patch strategy.
- The full global chat plan has since landed.

Recommended action:

- Keep under `docs/archive/` as historical context.

### `archive/global-chat-phase-d-validation.md`

Status: historical.

Reason:

- It records a completed benchmark run and PASS result from 2026-03-06.
- It is evidence, not an active plan.

Recommended action:

- Keep under `docs/archive/` as validation evidence.

## Absorbed Reference Material

### `ufoo-design-role-presets-from-gstack.md`

Status: implemented.

Implemented / absorbed:

- `design-system-consultant` exists.
- `ui-plan-critic` exists.
- `design-critic` exists.
- `frontend-refiner` exists.
- `design-system` built-in group exists.
- `ui-plan-review` built-in group exists.
- `ui-polish` built-in group exists.

Recommended action:

- Keep as source/reference material for the implemented design profiles and
  group templates.

## Cleanup Applied And Remaining

Applied on 2026-04-26:

1. Normalized stale top-level `Status:` lines to:
   - `implemented`
   - `implemented-with-gaps`
   - `active-draft`
   - `post-v1-backlog`
   - `historical`
   - `reference-material`
2. Added short "Implementation Audit" sections to implemented or mostly
   implemented plans whose previous status lines were stale.
3. Moved historical global-chat spike/validation docs and the Phase 4 prep
   inventory under `docs/archive/`.

Applied on 2026-05-24:

1. Added `docs/README.md` as the current documentation index and archive policy.
2. Moved completed plan/design/reference docs under `docs/archive/`.
3. Kept active drafts, backlog docs, and implemented-with-gaps plans at the
   top level.

Remaining follow-up:

Use `docs/README.md` as the current source for follow-up status.
