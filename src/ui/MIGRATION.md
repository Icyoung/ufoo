# Ink TUI Migration Plan

Status: P1 (ucode TUI) feature-complete behind `UFOO_TUI=ink`. P2 (internal
agent view) and P3 (chat TUI) outstanding.

## Why

The legacy chat, ucode and internal-agent TUIs all use blessed. Blessed is
an unmaintained imperative widget tree with no modern equivalent of React's
component model, and it's awkward to extend (manual layout math, manual
redraws, no useful test harness).

ink (the React-for-terminals library, what Claude Code, Codex CLI fronts
and the Gemini CLI all use) gives us declarative components, flexbox
layout, hooks, and proper isolation of pure logic from rendering.

## Approach

- Two TUIs coexist behind `UFOO_TUI=ink` until each phase signs off.
- Pure helpers live in `src/ui/format/` and are shared by both, so behaviour
  parity is enforced by test rather than copy/paste.
- Components live in `src/ui/components/`, written in plain JS via
  `React.createElement` (no JSX, no build step) so jest stays vanilla.
- ink is loaded through `src/ui/runInk.js`, a thin CJS→ESM bridge so the
  rest of the codebase stays CommonJS.

## Progress

- **P0** ✅ ink + react deps, runtime bridge, `<InkDemo>` smoke harness,
  pure helpers extracted to `src/ui/format/`.
- **P1** ✅ ucode TUI ported to ink behind `UFOO_TUI=ink`.
- **P2** ⏳ internal agent view (PTY mirror) — pending.
- **P3** ⏳ chat TUI — pending.
- **P4** ⏳ remove blessed dep, flip default — pending.

## P1 ucode TUI — what's wired

| Feature | Status |
|---|---|
| Banner + version + session id header | ✅ |
| Scrolling `<Static>` log (1000 line cap) | ✅ |
| Multiline input (cursor math, Ctrl+A/E/B/F/D/H/K/U/W, Meta+B/F/D, `\\\n` continuation, Alt+Enter newline, CJK wrap) | ✅ |
| Up/Down history walk + agent-selection mode | ✅ |
| Ctrl+C exit, Ctrl+O expand last tool group | ✅ |
| Tool merge/freeze/expand state machine | ✅ |
| Spinner + phase status line (request/thinking/text/tool labels) | ✅ |
| Esc abort with `AbortController` and "Cancelling..." status | ✅ |
| Agents footer with single-line truncation + `+N more` hint | ✅ |
| `runSingleCommand` empty/exit/probe/help/error/tool/nl kinds | ✅ |
| Background tasks ("BG x/y/z" suffix) | ⏳ deferred |
| ubus / resume / nl_bg branches | ⏳ deferred |
| autoBus polling | ⏳ deferred |

## Real-TTY checklist (run before flipping the default)

```sh
UFOO_TUI=ink ./bin/ucode.js
```

### Editor

- [ ] Type, see characters appear with the cursor on the next cell.
- [ ] Backspace deletes one cell back; cursor stays correct on CJK.
- [ ] Left/Right arrows move the cursor; resetting preferred col.
- [ ] Up/Down on a single line walks input history.
- [ ] Up/Down on a multiline value moves between visual rows.
- [ ] `\` followed by Enter inserts a newline; Enter alone submits.
- [ ] Alt+Enter inserts a newline.
- [ ] Ctrl+A / Ctrl+E jump to row start / end.
- [ ] Ctrl+W deletes the previous word (also Meta+Backspace).
- [ ] Long pasted text doesn't lock up the renderer.
- [ ] Resize the terminal — input frame and footer span the new width.

### Status line

- [ ] Shows `UCODE · Ready` while idle.
- [ ] Shows a spinning indicator + phase ("Waiting for model...",
  "Thinking...", "Generating response...", "Calling X...") during
  `runNaturalLanguageTask`.
- [ ] Appends `(<elapsed> s, esc cancel)` when a task is in flight.
- [ ] Esc on a running task flips to "Cancelling..." then back to Ready.

### Tool calls

- [ ] Single tool call renders one line (`· tool · detail`).
- [ ] Two+ consecutive tool calls collapse to one row + `(Ctrl+O expand)`.
- [ ] Ctrl+O expands the most recent group with `│`/`└` branch markers
  and only fires once per group.
- [ ] When text arrives between tool calls, the previous group freezes
  into the log and a fresh group starts on the next tool call.

### Agents footer

- [ ] Shows `Agents: none  │ No target agents` when nothing's online.
- [ ] Shows `Agents: @x @y ...  │ ↓ select target · ←/→ switch` otherwise.
- [ ] At narrow widths, the row stays single-line, drops trailing chips
  and emits ` +N more`.
- [ ] Down enters selection mode (first chip inverse). Left/Right cycle.
  Up exits. Prompt prefix changes to `›@<name> ` when locked.

### Smoke

- [ ] `node scripts/ucode-app-smoke.js` exits 0.
- [ ] `npx jest --silent` shows the pre-existing 5 OAuth failures only;
  every ink suite passes.

## Decision log

- **Don't fork ink.** Claude-code-fixed inlines a customised ink under
  `src/ink/`; we don't need React 19 / ConcurrentRoot / IDE bridging,
  so depending on the public `ink@5` keeps maintenance cost low.
- **Don't add JSX.** `React.createElement` keeps jest CJS happy and
  avoids a build step. We can revisit if any single component grows
  past ~600 lines and readability suffers.
- **Don't enable `--experimental-vm-modules` for jest.** The risk of
  surprise ESM behaviour across the existing 1800-test suite is too
  high. Render coverage stays in `scripts/*-smoke.js`; component logic
  is exercised by pure-function tests.
- **Codex isn't a useful reference.** Its TUI is a Rust ratatui app
  (`codex-rs/tui`), not React-based. The architectural principle worth
  borrowing is its hard split between TUI and core protocol.
