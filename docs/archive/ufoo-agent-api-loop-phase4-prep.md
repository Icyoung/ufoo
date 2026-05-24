---
title: ufoo-agent API/Loop — Phase 4 Legacy Retirement Prep
owner: ufoo-builder-3
lane: decision-0292-builder-3
status: historical
last_updated: 2026-04-20
---

# Phase 4 Prep: Legacy `assistant_call` / helper-agent Retirement

Status: historical

## 0. Scope

This document was the **pre-deletion** inventory for the Phase 4 retirement of
`assistant_call` and the `ufoo-assistant-agent` helper.

Deletion has now landed. Keep this file as historical inventory only.

The original deletion gating assumptions were:

1. Tier 0–2 tool coverage parity (`src/tools/**` — builder-1 lane)
2. Provider cutover stability (`src/providerapi/**`, Claude/Codex runners — builder-2 lane)
3. Loop observability + flag transitions (`src/controller/**`, loop runtime — builder-4 lane)

Until those gates are green, the compile-time gate added in this lane is the
only enforcement. The gate:

- `promptLoop.runPromptWithAssistant` resolves controller mode and short-circuits
  the helper invocation when mode ∈ `{router-api, loop}`, emitting
  `controller.deprecation_path` to the loop-events log.
- `ufooAgent.buildSystemPrompt` omits the `assistant_call` schema entry and
  instructs the model not to emit it when mode ∈ `{router-api, loop}`.
- `legacy` and `shadow` modes continue to accept helper invocations unchanged.

## 1. 30-day `assistant_call` sample inventory

Source: `.ufoo/agent/reports.jsonl` `phase=start` rows with
`agent_id="ufoo-assistant-agent"`. Window: 2026-03-21 → 2026-04-20.

Totals: **12 invocations** (24 report events = 12 start + 12 done, 0 error).

| # | ts (UTC)              | kind    | provider   | task summary (clipped)                                                                             |
|---|-----------------------|---------|------------|----------------------------------------------------------------------------------------------------|
| 1 | 2026-03-21T16:48:24Z  | explore | claude-cli | Check current test coverage and identify areas needing improvement                                 |
| 2 | 2026-03-21T16:52:05Z  | explore | claude-cli | Search `src/chat/`, `src/code/`, `src/terminal/` for input-box + cursor logic                      |
| 3 | 2026-03-21T17:12:15Z  | explore | claude-cli | `task: "dummy"` — smoke test of helper pipeline                                                    |
| 4 | 2026-03-21T17:53:58Z  | explore | claude-cli | Read builder coverage status note (no fs action — informational)                                   |
| 5 | 2026-03-21T17:57:41Z  | explore | claude-cli | Confirm existing coverage-related cron                                                             |
| 6 | 2026-03-22T03:18:21Z  | explore | claude-cli | List cron to avoid duplicate coverage patrol                                                       |
| 7 | 2026-03-26T04:48:06Z  | bash    | claude-cli | `git status` + `git diff --stat` + `package.json` version check                                    |
| 8 | 2026-04-01T10:09:34Z  | bash    | claude-cli | `git diff --stat HEAD`                                                                             |
| 9 | 2026-04-01T10:33:50Z  | bash    | claude-cli | `git diff --stat HEAD && git log --oneline -5`                                                     |
|10 | 2026-04-20T03:03:19Z  | mixed   | codex      | Verify npm version ↔ local code sync (tags, changelog, package.json)                               |
|11 | 2026-04-20T11:27:10Z  | explore | codex      | Inspect `docs/ufoo-agent-api-loop-plan.md` + repo state for PMO slice decomposition                |
|12 | 2026-04-20T11:47:18Z  | explore | codex      | Re-inspect plan + repo state (second PMO round)                                                    |

Observations:

- Usage is bursty around PMO planning sessions; non-planning days see zero calls.
- All samples succeeded (no `phase=error` recorded in the window).
- `kind` distribution: explore 8/12, bash 3/12, mixed 1/12. `bash` is uniformly
  used for read-only git introspection.
- Two providers exercised: `claude-cli` (pre-2026-04-20) and `codex` (2026-04-20
  PMO sessions). No `ucode` / native helper usage observed.

## 2. Tier 0–2 tool coverage mapping

Tool inventory (decision 0292 §Builder-1):

- **Tier 0 (read)**: `readBusSummary`, `readPromptHistory`, `readOpenDecisions`,
  `listAgents`, `readProjectRegistry`
- **Tier 1 (shared handler)**: `dispatch_message`, `ack_bus` (loop-side runtime
  tools exposed via `controllerToolExecutor`)
- **Tier 2 (live)**: `launchAgent`, `renameAgent`, `closeAgent`, `manageCron`

| # | Sample                                  | Covered by                        | Gap                                                          |
|---|-----------------------------------------|-----------------------------------|--------------------------------------------------------------|
| 1 | test coverage inspection                | —                                 | **Workspace file read** (`readWorkspaceFile` / scoped `Read`) + test runner output capture |
| 2 | code search `src/chat`, `src/terminal`  | —                                 | **Workspace grep/glob tool** (Tier 0 read with path sandbox) |
| 3 | dummy smoke test                        | N/A (test probe)                  | Retire sample path; no tool needed                           |
| 4 | coverage status note (informational)    | `readBusSummary` (partial)        | Tier 0 note: prompt history already exposes the text; low risk |
| 5 | confirm existing cron                   | `manageCron` (op=list) ✅         | COVERED                                                      |
| 6 | cron list (deduplication check)         | `manageCron` (op=list) ✅         | COVERED                                                      |
| 7 | `git status` + `git diff --stat` + version | —                              | **Scoped git read tool** (e.g. `readGitStatus`, `readGitDiffStat`, `readPackageVersion`) |
| 8 | `git diff --stat HEAD`                  | —                                 | **Scoped git read tool** (`readGitDiffStat`)                 |
| 9 | `git diff --stat HEAD` + `git log`      | —                                 | `readGitDiffStat` + `readGitLog`                             |
|10 | npm ↔ code sync (tags, changelog, package.json) | —                         | Tier 0: `readPackageVersion`, `readGitTags`, `readWorkspaceFile(CHANGELOG)` |
|11 | plan md + repo state inspection         | `readOpenDecisions` (partial)     | **Workspace file read** for `docs/` markdown + `readWorkspaceFile`  |
|12 | plan md + repo state (re-inspection)    | `readOpenDecisions` (partial)     | Same as #11                                                  |

**Coverage ratio today: 2/12 samples fully covered (16.7%).**

**Highest-leverage gaps** (one tool unblocks multiple samples):

| Missing Tier 0 tool         | Samples unblocked | Notes                                                                       |
|------------------------------|-------------------|-----------------------------------------------------------------------------|
| `readWorkspaceFile(path)`    | 1, 2, 10, 11, 12 | Must be path-sandboxed to project root; redactor must run on output.        |
| `readGitStatusShort`         | 7                 | `git status --short` output; no shell escape.                               |
| `readGitDiffStat`            | 7, 8, 9           | Bounded to `HEAD` / branch range; output size cap.                          |
| `readGitLogSummary`          | 9                 | `git log --oneline -N` with N cap.                                          |
| `readGitTags`                | 10                | `git tag --sort=-creatordate` with output cap.                              |
| `readPackageVersion`         | 7, 10             | Parse `package.json.version` from project root only.                        |
| `searchWorkspaceSymbols`     | 2                 | Glob / grep tool with result cap and path sandbox. Redactor on output.      |

Samples 3 (dummy smoke test) and 4 (informational read from bus summary) do not
require a dedicated tool — sample 4 is already derivable from existing Tier 0
`readBusSummary` / `readPromptHistory`.

## 3. Helper-agent call graph + entry inventory

### 3.1 Call graph (current, legacy path only)

```
daemon IPC (PROMPT request)
  └── daemon/promptRequest.handlePromptRequest        [builder-4 owner, not modified this lane]
       ├── controller mode ∈ {legacy, shadow}
       │    └── promptRunner = promptLoop.runPromptWithAssistant   ← lane-3 gate here
       │         ├── runUfooAgent (round 1) → payload may contain { assistant_call }
       │         ├── [GATE: mode ∈ {legacy, shadow}]
       │         │    └── assistant/bridge.runAssistantTask
       │         │         └── spawn bin/ufoo-assistant-agent.js
       │         │              └── src/assistant/stdio.runAssistantStdio
       │         │                   └── src/assistant/agent.runAssistantAgentTask
       │         │                        ├── resolveAssistantEngine
       │         │                        │    ├── kind=external  → engine.runExternalAssistantEngine
       │         │                        │    └── kind=cli       → src/agent/cliRunner.runCliAgent
       │         │                        └── saveAssistantState (.ufoo/agent/sessions/*.json)
       │         └── runUfooAgent (round 2) with assistant reports → final payload
       │
       ├── controller mode = router-api
       │    └── routerFastPath attempted first (builder-4 code)
       │    └── fallback → runPromptWithAssistant
       │         └── [GATE short-circuits helper; emits controller.deprecation_path]
       │
       └── controller mode = loop
            └── promptRunner = loopRuntime.runPromptWithControllerLoop   [builder-4 owner]
                 └── (never invokes assistant_call; model prompt forbids it)
```

### 3.2 Entry points to delete in Phase 4 (in order)

| # | File                                     | Symbol / section                              | Notes                                                                 |
|---|------------------------------------------|-----------------------------------------------|-----------------------------------------------------------------------|
| A | `src/daemon/promptLoop.js`               | `runPromptWithAssistant`, `extractAssistantCall`, `normalizeAssistantCall`, `buildAssistantContinuationPrompt`, `buildAssistantReport`, `createAssistantTaskId`, `emitAssistantReport`, `annotateAssistantFailureFallback` | Entire file can be deleted if `promptRequest.js` routes to loop runtime exclusively. |
| B | `src/daemon/promptRequest.js`            | `promptRunner` selection + `runAssistantTask` wire-in | builder-4 owns this file. Removal must be coordinated.                |
| C | `src/daemon/index.js`                    | `const { runAssistantTask } = require("../assistant/bridge")` + plumbing | One-line plumbing. Delete after A + B.                                 |
| D | `src/assistant/bridge.js`                | `runAssistantTask`, `resolveAssistantCommand`, `parseAssistantOutput`, `normalizeResponse` | Pure helper invocation layer.                                          |
| E | `src/assistant/stdio.js`                 | `runAssistantStdio`                            | Entry loop for the helper binary.                                      |
| F | `src/assistant/agent.js`                 | `runAssistantAgentTask`, session state helpers | Core helper logic.                                                     |
| G | `src/assistant/engine.js`                | `resolveAssistantEngine`, `runExternalAssistantEngine` | Engine selector; only consumer is F.                                   |
| H | `src/assistant/constants.js`             | `DEFAULT_ASSISTANT_TIMEOUT_MS`, etc.          | Other callers (ufooAgent.js schema text) must migrate off first.       |
| I | `src/assistant/ufooEngineCli.js`         | `ufoo-engine` CLI glue                        | Standalone; confirm no docs/bin reference remains.                     |
| J | `bin/ufoo-assistant-agent.js`            | binary entrypoint                              | Delete after D–G.                                                      |
| K | `src/agent/ufooAgent.js`                 | assistant_call schema lines, rules, imports from `src/assistant/constants` | Already gated; full removal drops the schema entirely. |
| L | `src/agent/cliRunner.js`                 | assistant_call-only code paths (search for `assistant`) | Only if truly unused after D–H (verify via grep).                      |
| M | `test/unit/**/assistant*.test.js` + `test/unit/daemon/promptLoop.test.js` | delete or port to loop-runtime tests | Tests must be migrated or removed in the same commit as their subject. |
| N | `docs/` references                       | Any user-facing documentation mentioning `assistant_call` | Scrub after code removal.                                              |

### 3.3 Known external contracts that leak the name `assistant_call`

- `src/assistant/constants.js::DEFAULT_ASSISTANT_TIMEOUT_MS` is imported by
  `src/agent/ufooAgent.js` to label the schema’s `timeout_ms`. Removing H
  requires inlining the constant or dropping the schema line (already gated).
- `reports.jsonl` historical rows with `agent_id="ufoo-assistant-agent"` are
  still read by status dashboards. Retention check needed before log rotation.
- `.ufoo/agent/sessions/ufoo-assistant-*.json` session files will linger on
  disk; add a one-time cleanup step in the deletion commit.

## 4. Proposed deletion commit sequence

Each commit is atomic, reviewable, and leaves tests green. Do not interleave
with other builders’ lanes.

1. **Commit 1 — finalize gate (ALREADY IN FLIGHT, this lane)**
   - `src/daemon/promptLoop.js`: runtime short-circuit + `deprecation_path` event
   - `src/agent/ufooAgent.js`: schema gate when controller mode ∈ `{router-api, loop}`
   - Tests: `promptLoop.test.js`, `ufooAgent.test.js`
   - Doc: this file

2. **Commit 2 — flip default** (gate opens: PMO must re-approve)
   - Flip default `controllerMode` to `router-api` in `.ufoo/config.json` schema
     and in `normalizeControllerMode` fallback (builder-4 lane)
   - Soak: 7+ days of production telemetry, zero `controller.deprecation_path`
     events attributed to the model emitting `assistant_call`

3. **Commit 3 — remove entry from `promptRequest.js`** (builder-4 owner)
   - Drop `promptRunner = legacy` branch; keep only loop-runtime routing
   - Leaves `runPromptWithAssistant` as dead code (callable only from tests)

4. **Commit 4 — delete `promptLoop.js`** (this lane)
   - Remove `src/daemon/promptLoop.js`
   - Remove `test/unit/daemon/promptLoop.test.js`
   - Remove `runPromptWithAssistant` import from `src/daemon/index.js`

5. **Commit 5 — delete bridge + helper runtime**
   - Remove `src/assistant/bridge.js`, `stdio.js`, `agent.js`, `engine.js`,
     `ufooEngineCli.js`, `bin/ufoo-assistant-agent.js`
   - Remove related tests under `test/unit/assistant/**`
   - Remove plumbing in `src/daemon/index.js`

6. **Commit 6 — scrub schema + constants**
   - Remove helper-gated branches from `src/agent/ufooAgent.js`
     (`isHelperAllowedControllerMode`, deprecation rule text)
   - Remove `src/assistant/constants.js`
   - Inline or drop `DEFAULT_ASSISTANT_TIMEOUT_MS` usage

7. **Commit 7 — cleanup disk state**
   - One-shot migration to delete `.ufoo/agent/sessions/ufoo-assistant-*.json`
   - Update user-facing docs under `docs/` to remove `assistant_call` references

8. **Commit 8 — remove deprecation_path emission**
   - Once no callers remain, drop `controller.deprecation_path` from the
     loop-observability enumeration (builder-4 lane)

## 5. Gating summary (current state, end of this lane)

| Surface                                   | Mode legacy | Mode shadow | Mode router-api | Mode loop  |
|-------------------------------------------|-------------|-------------|-----------------|------------|
| `ufooAgent.buildSystemPrompt` emits `assistant_call` schema | yes         | yes         | **no**          | **no** (via loopRuntime or direct gate) |
| `promptLoop.runPromptWithAssistant` invokes helper          | yes         | yes         | **short-circuit**, emits `controller.deprecation_path` | **short-circuit**, emits `controller.deprecation_path` |
| `controller.deprecation_path` payload fields                | —           | —           | `path=assistant_call`, `controller_mode`, `allowed_modes`, `short_circuited=true`, `reason=helper_retirement_gated`, `kind`, `task_chars` | same |

## 6. Risks + open questions for PMO

1. **Provider diversity shift**: 30-day sample shows helper usage migrated from
   `claude-cli` to `codex` on 2026-04-20. Phase 4 prerequisite §2 (provider
   cutover) must confirm Codex SDK path is stable before deletion — otherwise
   PMO will be retiring the only fallback helper currently serving codex.
2. **Unmet exploration need**: 10/12 samples depend on a Tier 0
   `readWorkspaceFile`-like primitive that does not yet exist. Builder-1 lane
   currently covers 5 read tools; none are workspace-file reads. Phase 4 cannot
   proceed without at least `readWorkspaceFile` + `readGitDiffStat` +
   `readPackageVersion`.
3. **Observability retention**: `controller.deprecation_path` is written to
   `.ufoo/agent/ufoo-agent.loop-events.jsonl`. Confirm log rotation policy
   retains at least 30 days so the soak window in Commit 2 is auditable.
4. **Global-router path**: the gated schema branch also applies to
   `global-router` mode. If the global controller is ever run under
   `legacy`/`shadow` by accident, it will still emit `assistant_call` — the
   runtime gate in `promptLoop.js` is still authoritative.

## 7. Test surface (this lane)

Green as of 2026-04-20 under Node harness:

- `test/unit/daemon/promptLoop.test.js` (13 tests, incl. 5 new gating cases)
- `test/unit/daemon/promptRequest.test.js` (pre-existing, untouched)
- `test/unit/daemon/promptRequest.loop.test.js` (pre-existing, untouched)
- `test/unit/agent/ufooAgent.test.js` (3 new schema-gate cases, rest unchanged)
- `test/unit/controller/routerFastPath.test.js` (untouched)

Out-of-lane failures remain (`ucodexBin`, `uclaudeBin`, `redactorSlices`,
`internalRunner`, `hostAdapter`). These belong to builder-2 / builder-4 /
unrelated lanes and pre-date this lane's work — verified via `git stash` baseline.
