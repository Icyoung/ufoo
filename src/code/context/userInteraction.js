"use strict";

/**
 * User interaction (approval / choice / chat) for Agent Loop.
 *
 * Continuity rule: the question lives in the prior ask_user tool-call args
 * (or checkpoint waitingFor). The answer is only the payload — never restate
 * the question — and is written as the matching tool_result so it sits
 * immediately after that tool call in the model transcript.
 */

const { randomUUID } = require("crypto");
const { advanceStoredGraph } = require("./planGraphService");

const INTERACTION_KINDS = Object.freeze(["approval", "choice", "chat"]);

function createInteractionId() {
  return `ui_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

function ensureInteractionState(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  if (state.pendingUserInteraction === undefined) {
    state.pendingUserInteraction = null;
  }
  return state;
}

function getPendingUserInteraction(executionState = null) {
  const state = ensureInteractionState(executionState);
  return state.pendingUserInteraction && typeof state.pendingUserInteraction === "object"
    ? state.pendingUserInteraction
    : null;
}

function hasPendingUserInteraction(executionState = null) {
  return Boolean(getPendingUserInteraction(executionState));
}

function clearPendingUserInteraction(executionState = null) {
  const state = ensureInteractionState(executionState);
  state.pendingUserInteraction = null;
  return state;
}

function normalizeOptions(kind = "chat", options = []) {
  if (kind === "approval") {
    if (Array.isArray(options) && options.length > 0) {
      return options.map((opt, index) => normalizeOption(opt, index)).filter(Boolean);
    }
    return [
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
    ];
  }
  if (kind === "choice") {
    const list = Array.isArray(options) ? options : [];
    return list.map((opt, index) => normalizeOption(opt, index)).filter(Boolean);
  }
  return [];
}

function normalizeOption(opt, index = 0) {
  if (typeof opt === "string") {
    const label = String(opt || "").trim();
    if (!label) return null;
    return { key: String(index + 1), label };
  }
  if (!opt || typeof opt !== "object") return null;
  const label = String(opt.label || opt.text || opt.title || "").trim();
  const key = String(opt.key || opt.id || index + 1).trim();
  if (!label && !key) return null;
  return { key: key || String(index + 1), label: label || key };
}

/**
 * Create a pending interaction. Caller must attach resume.call so the answer
 * can be written as the deferred ask_user tool_result.
 */
function requestUserInteraction(executionState = null, input = {}) {
  const state = ensureInteractionState(executionState);
  if (state.pendingUserInteraction) {
    return {
      ok: false,
      status: "rejected",
      code: "INTERACTION_ALREADY_PENDING",
      error: "Another user interaction is already pending",
      interactionId: state.pendingUserInteraction.id,
      executionState: state,
    };
  }

  let kind = String(input.kind || input.type || "chat").trim().toLowerCase();
  if (kind === "yes_no" || kind === "yesno" || kind === "confirm") kind = "approval";
  if (kind === "select" || kind === "options") kind = "choice";
  if (!INTERACTION_KINDS.includes(kind)) kind = "chat";

  const prompt = String(input.prompt || input.question || input.message || "").trim();
  if (!prompt) {
    return {
      ok: false,
      status: "rejected",
      code: "MISSING_PROMPT",
      error: "prompt is required",
      executionState: state,
    };
  }

  const options = normalizeOptions(kind, input.options);
  if (kind === "choice" && options.length < 2) {
    return {
      ok: false,
      status: "rejected",
      code: "CHOICE_REQUIRES_OPTIONS",
      error: "choice requires at least 2 options",
      executionState: state,
    };
  }

  const interaction = {
    id: createInteractionId(),
    kind,
    prompt,
    options,
    allowFreeChat: input.allowFreeChat !== false,
    origin: input.origin && typeof input.origin === "object"
      ? { ...input.origin }
      : { type: "ask_user" },
    resume: input.resume && typeof input.resume === "object" ? { ...input.resume } : null,
    createdAt: new Date().toISOString(),
  };

  state.pendingUserInteraction = interaction;
  return {
    ok: true,
    status: "waiting_user",
    waiting_user: true,
    interactionId: interaction.id,
    kind: interaction.kind,
    // Model-facing wait ack: no answer yet; question stays in tool args only.
    summary: "Waiting for user response",
    executionState: state,
  };
}

/**
 * Sync pending approval UI from plan-graph checkpoint yield.
 * No ask_user tool call — answer will be a short contiguous user message
 * referencing nodeId only (question already in waitingFor / prior tool output).
 */
function syncInteractionFromPlanGraph(executionState = null) {
  const state = ensureInteractionState(executionState);
  if (state.pendingUserInteraction) return state.pendingUserInteraction;

  const pg = state.planGraph && typeof state.planGraph === "object" ? state.planGraph : null;
  const waiting = pg && pg.waitingFor && typeof pg.waitingFor === "object" ? pg.waitingFor : null;
  if (!waiting || waiting.type !== "checkpoint") return null;
  if (String(pg.lastYieldReason || "") !== "approval_required" && waiting.mode !== "approval") {
    return null;
  }

  const reason = String(waiting.reason || "Approval required").trim() || "Approval required";
  const created = requestUserInteraction(state, {
    kind: "approval",
    prompt: reason,
    origin: {
      type: "checkpoint",
      nodeId: waiting.id || "",
      graphId: pg.graphId || "",
    },
    resume: { mode: "checkpoint" },
  });
  return created.ok ? state.pendingUserInteraction : null;
}

function parseUserInteractionInput(pending = null, rawText = "") {
  const text = String(rawText || "").trim();
  if (!pending || !text) {
    return { ok: false, code: "EMPTY", error: "empty answer" };
  }

  const kind = String(pending.kind || "chat");
  const options = Array.isArray(pending.options) ? pending.options : [];
  const lowered = text.toLowerCase();

  if (kind === "approval" || kind === "choice") {
    // Exact key match
    const byKey = options.find((opt) => String(opt.key).toLowerCase() === lowered);
    if (byKey) {
      return {
        ok: true,
        answerKind: "option",
        selected: byKey.key,
        label: byKey.label,
      };
    }
    // Approval aliases
    if (kind === "approval") {
      if (["y", "yes", "ok", "okay", "approve", "approved", "是", "好", "同意"].includes(lowered)) {
        const yes = options.find((o) => String(o.key).toLowerCase() === "yes") || options[0];
        return {
          ok: true,
          answerKind: "option",
          selected: yes ? yes.key : "yes",
          label: yes ? yes.label : "Yes",
        };
      }
      if (["n", "no", "reject", "rejected", "cancel", "denied", "否", "不", "取消"].includes(lowered)) {
        const no = options.find((o) => String(o.key).toLowerCase() === "no") || options[1] || options[0];
        return {
          ok: true,
          answerKind: "option",
          selected: no ? no.key : "no",
          label: no ? no.label : "No",
        };
      }
    }
    // Numeric index for choice (1-based)
    if (/^\d+$/.test(text)) {
      const index = Number(text) - 1;
      if (index >= 0 && index < options.length) {
        return {
          ok: true,
          answerKind: "option",
          selected: options[index].key,
          label: options[index].label,
        };
      }
    }
    // Label match (case-insensitive)
    const byLabel = options.find((opt) => String(opt.label).toLowerCase() === lowered);
    if (byLabel) {
      return {
        ok: true,
        answerKind: "option",
        selected: byLabel.key,
        label: byLabel.label,
      };
    }

    if (pending.allowFreeChat !== false) {
      return { ok: true, answerKind: "chat", text };
    }
    return {
      ok: false,
      code: "INVALID_OPTION",
      error: kind === "approval"
        ? "Reply yes/no, or type a free-text answer"
        : "Reply with an option number/key, or type a free-text answer",
    };
  }

  // kind === chat
  return { ok: true, answerKind: "chat", text };
}

/**
 * Answer-only payload for the model (no question echo).
 * Stays adjacent to ask_user via tool_result, or as a short follow-up for checkpoint.
 */
function buildAnswerPayload(pending = null, parsed = {}) {
  const base = {
    type: "user_answer",
    interactionId: pending && pending.id ? pending.id : "",
    kind: pending && pending.kind ? pending.kind : "chat",
    ok: true,
  };
  if (parsed.answerKind === "option") {
    return {
      ...base,
      answerKind: "option",
      selected: parsed.selected,
      label: parsed.label || "",
    };
  }
  return {
    ...base,
    answerKind: "chat",
    text: String(parsed.text || "").trim(),
  };
}

function applyCheckpointDecision(executionState = null, pending = null, parsed = {}) {
  const state = ensureInteractionState(executionState);
  const nodeId = pending && pending.origin && pending.origin.nodeId
    ? String(pending.origin.nodeId)
    : "";
  const pg = state.planGraph;
  if (!pg || !Array.isArray(pg.nodes) || !nodeId) {
    return { ok: false, code: "CHECKPOINT_MISSING" };
  }
  const idx = pg.nodes.findIndex((n) => n && n.id === nodeId);
  if (idx < 0) return { ok: false, code: "CHECKPOINT_MISSING" };
  const node = pg.nodes[idx];
  if (node.type !== "checkpoint") return { ok: false, code: "NOT_CHECKPOINT" };

  const approved = parsed.answerKind === "option"
    && ["yes", "y", "ok", "approve", "approved"].includes(String(parsed.selected || "").toLowerCase());
  const rejected = parsed.answerKind === "option"
    && ["no", "n", "reject", "rejected", "cancel", "denied"].includes(String(parsed.selected || "").toLowerCase());

  if (parsed.answerKind === "chat") {
    // Free-text on approval checkpoint: leave node waiting; agent decides via contiguous answer msg.
    return { ok: true, advanced: false, chatOverride: true };
  }

  if (approved) {
    pg.nodes[idx] = {
      ...node,
      status: "succeeded",
      result: {
        ok: true,
        summary: `approved (${parsed.selected})`,
        output: { selected: parsed.selected, label: parsed.label || "" },
      },
      error: "",
    };
  } else if (rejected) {
    pg.nodes[idx] = {
      ...node,
      status: "cancelled",
      result: {
        ok: false,
        summary: `rejected (${parsed.selected})`,
        output: { selected: parsed.selected, label: parsed.label || "" },
      },
      error: "",
    };
  } else {
    return { ok: false, code: "UNKNOWN_DECISION" };
  }

  pg.waitingFor = null;
  pg.lastYieldReason = "";
  const advanced = advanceStoredGraph(pg, { autoAdvance: false });
  if (advanced && advanced.planGraph) {
    state.planGraph = {
      ...advanced.planGraph,
      commandLog: pg.commandLog || {},
    };
    if (state.graphs && state.planGraph.graphId) {
      state.graphs[state.planGraph.graphId] = state.planGraph;
    }
  }
  return { ok: true, advanced: true, approved: Boolean(approved) };
}

/**
 * Resolve user text against pending interaction.
 * Returns answer payload + how to continue the agent loop.
 */
function resolveUserInteraction(executionState = null, rawText = "") {
  const state = ensureInteractionState(executionState);
  const pending = getPendingUserInteraction(state);
  if (!pending) {
    return { ok: false, code: "NO_PENDING", error: "no pending user interaction" };
  }

  const parsed = parseUserInteractionInput(pending, rawText);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, error: parsed.error, pending };
  }

  const answer = buildAnswerPayload(pending, parsed);
  const resume = pending.resume && typeof pending.resume === "object" ? { ...pending.resume } : null;
  const origin = pending.origin || {};

  let checkpoint = null;
  if (resume && resume.mode === "checkpoint") {
    checkpoint = applyCheckpointDecision(state, pending, parsed);
  }

  clearPendingUserInteraction(state);

  return {
    ok: true,
    answer,
    parsed,
    pendingSnapshot: pending,
    resume,
    origin,
    checkpoint,
    // ask_user path: write answer as deferred tool_result (contiguous).
    // checkpoint path without tool: short user message with answer only.
    continueMode: resume && resume.toolCallId ? "tool_result" : "user_message",
    executionState: state,
  };
}

function formatInteractionPromptLines(pending = null) {
  if (!pending) return [];
  const lines = [];
  const kind = pending.kind || "chat";
  if (kind === "approval") {
    lines.push(`Approval: ${pending.prompt}`);
    lines.push("  [yes] Yes    [no] No    or type a free-text reply");
  } else if (kind === "choice") {
    lines.push(`Choice: ${pending.prompt}`);
    for (const opt of pending.options || []) {
      lines.push(`  [${opt.key}] ${opt.label}`);
    }
    if (pending.allowFreeChat !== false) {
      lines.push("  or type a free-text reply");
    }
  } else {
    lines.push(`Question: ${pending.prompt}`);
    lines.push("  (type your reply)");
  }
  return lines;
}

function runAskUserTool(args = {}, options = {}) {
  const executionState = options.executionState;
  const result = requestUserInteraction(executionState, {
    kind: args.kind || args.type || "chat",
    prompt: args.prompt || args.question || args.message,
    options: args.options,
    allowFreeChat: args.allowFreeChat !== false,
    origin: { type: "ask_user" },
    // resume.call filled by nativeRunner after it knows tool_call id
    resume: options.resume || null,
  });
  return {
    ...result,
    // Keep tool wait ack tiny — question is only in args.
    modelPayload: result.ok
      ? {
        ok: true,
        status: "waiting_user",
        interactionId: result.interactionId,
        kind: result.kind,
      }
      : {
        ok: false,
        status: "rejected",
        error: result.error || "ask_user rejected",
        code: result.code || "",
      },
  };
}

module.exports = {
  INTERACTION_KINDS,
  createInteractionId,
  ensureInteractionState,
  getPendingUserInteraction,
  hasPendingUserInteraction,
  clearPendingUserInteraction,
  requestUserInteraction,
  syncInteractionFromPlanGraph,
  parseUserInteractionInput,
  buildAnswerPayload,
  resolveUserInteraction,
  formatInteractionPromptLines,
  runAskUserTool,
  applyCheckpointDecision,
};
