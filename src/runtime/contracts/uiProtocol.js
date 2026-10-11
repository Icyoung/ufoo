"use strict";

/**
 * ufoo-ui/1 — Node host ↔ Rust TUI control protocol.
 *
 * Daemon IPC stays separate. This protocol never shares the TTY stdout used
 * for drawing; it rides a dedicated Unix socket (or extra fd).
 */

const PROTOCOL = "ufoo-ui/1";

// Capability advertised by clients that can render internal agent panes.
// window.set.mode is main | side | multi, independently of pane membership.
const MULTI_FRAMES_CAPABILITY = "multi-frames-v1";
const WINDOW_MODES_CAPABILITY = "window-modes-v1";

// Internal input uses an explicit agent_id and complete input/cursor draft.
// multi.raw.input_revision increases per child edit; submit=true commits that
// same draft. multi.pane.frame echoes input_revision, separately from transcript
// revision. Older echoes must not overwrite local edits. Frame entries are
// semantic and remain valid across viewport revisions. Ready/resync replays all
// visible pane frames, including quiet agents. input.submit.input_target=main
// explicitly clears a previous footer target; unresolved targets never fall back.

const KINDS = Object.freeze([
  "hello",
  "welcome",
  "command",
  "event",
  "snapshot",
  "result",
  "error",
]);

const COMMAND_NAMES = Object.freeze([
  "input.submit",
  "input.paste",
  "task.cancel",
  "agent.select",
  "agent.open",
  "agent.close",
  "project.switch",
  "project.close",
  "project.return_controller",
  "cron.stop",
  "completion.request",
  "command.execute",
  "interaction.respond",
  "settings.set",
  "settings.open",
  "ui.resync.request",
  "app.exit",
  "window.set",
  "window.cycle",
  "multi.focus",
  "multi.viewport",
  "multi.raw",
  "multi.scroll",
  "multi.expand",
]);

const EVENT_NAMES = Object.freeze([
  "app.snapshot",
  "transcript.reset",
  "transcript.append",
  "transcript.patch",
  "stream.start",
  "stream.delta",
  "stream.done",
  "thinking.start",
  "thinking.delta",
  "status.set",
  "agents.snapshot",
  "agents.patch",
  "projects.snapshot",
  "cron.snapshot",
  "loop.set",
  "completions.set",
  "interaction.request",
  "interaction.clear",
  "plan.set",
  "tool.start",
  "tool.result",
  "tool.group",
  "settings.snapshot",
  "prompt.apply_paste",
  "prompt.set_text",
  "prompt.restore",
  "prompt.set_prefix",
  "attachments.set",
  "usage.set",
  "connection.set",
  "error",
  "window.set",
  "multi.pane.frame",
]);

function createEnvelope({
  kind,
  name = "",
  requestId = null,
  seq = null,
  scope = null,
  payload = {},
} = {}) {
  const envelope = {
    protocol: PROTOCOL,
    kind: String(kind || "").trim(),
    name: String(name || "").trim(),
    payload: payload && typeof payload === "object" ? payload : {},
  };
  if (requestId != null && requestId !== "") {
    envelope.request_id = String(requestId);
  }
  if (Number.isFinite(seq)) {
    envelope.seq = Math.floor(seq);
  }
  if (scope && typeof scope === "object") {
    envelope.scope = {
      surface: String(scope.surface || ""),
      project_id: String(scope.project_id || scope.projectId || ""),
      view_id: String(scope.view_id || scope.viewId || "main"),
    };
  }
  return envelope;
}

function validateEnvelope(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["envelope must be an object"] };
  }
  if (raw.protocol !== PROTOCOL) {
    errors.push(`unsupported protocol "${raw.protocol}"`);
  }
  if (!KINDS.includes(String(raw.kind || ""))) {
    errors.push(`invalid kind "${raw.kind}"`);
  }
  if (raw.payload != null && typeof raw.payload !== "object") {
    errors.push("payload must be an object");
  }
  return { ok: errors.length === 0, errors };
}

function encodeMessage(envelope) {
  const check = validateEnvelope(envelope);
  if (!check.ok) {
    const err = new Error(`ufoo-ui encode failed: ${check.errors.join("; ")}`);
    err.code = "UFOO_UI_ENCODE";
    err.errors = check.errors;
    throw err;
  }
  return `${JSON.stringify(envelope)}\n`;
}

function decodeMessage(line) {
  const text = String(line || "").trim();
  if (!text) return { ok: false, errors: ["empty line"] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`invalid json: ${err.message}`] };
  }
  const check = validateEnvelope(parsed);
  if (!check.ok) return check;
  return { ok: true, envelope: parsed, errors: [] };
}

function createSeqCounter(start = 0) {
  let seq = Math.max(0, Math.floor(Number(start) || 0));
  return {
    next() {
      seq += 1;
      return seq;
    },
    peek() {
      return seq;
    },
  };
}

module.exports = {
  PROTOCOL,
  MULTI_FRAMES_CAPABILITY,
  WINDOW_MODES_CAPABILITY,
  KINDS,
  COMMAND_NAMES,
  EVENT_NAMES,
  createEnvelope,
  validateEnvelope,
  encodeMessage,
  decodeMessage,
  createSeqCounter,
};
