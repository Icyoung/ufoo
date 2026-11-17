"use strict";

const { buildCoreToolSpecs } = require("../../../code/tools/specs");
const { runCoreToolAsync } = require("../../../code/tools/executor");
const { emptyExecutionState } = require("../../../code/context/executionSegment");
const { parseStructuredSideEffects } = require("../../../code/context/stateCommit");
const { normalizePlanGraphCommand, activePlanRequiresExpansion } = require("../../../code/context/planGraphService");
const { planModeBlocksDirectTool } = require("../../../code/context/planMode");
const { drainUserPrompts, formatUserReminderMessage, ensurePendingUserPrompts, shouldAutoContinuePlan, buildPlanAutoContinueReminder } = require("../../../code/context/userNudge");
const { drainAgentMailboxForTurn, shouldAutoContinueForTaskWake, listTaskRunsAwaitingModel } = require("../../../code/runtime/agentWakeup");
const {
  shouldIsolateTaskFocusTurn,
  buildIsolatedTaskFocusTurn,
  sanitizeToolResultForModel,
  pickPrimaryAwaitingRun,
  waitingPlanNode,
} = require("../../../code/runtime/taskFocusContext");
const { hasPendingUserInteraction, getPendingUserInteraction } = require("../../../code/context/userInteraction");
const { checkWriteAllowed } = require("../../../code/runtime/workspaceLease");

const DATA_TOOLS = new Set(["read", "read_image", "write", "edit", "bash", "artifact_read", "browser", "mac_app"]);
const SIDE_EFFECT_DATA_TOOLS = new Set(["write", "edit", "bash"]);
const CONTROL_TOOLS = new Set(["plan_graph", "task_run"]);

function createPlanningPolicy() {
  const isolatedEpisodes = new WeakMap();
  function resolveFocusKey(state) {
    const run = pickPrimaryAwaitingRun(state);
    if (run && run.id) return `run:${run.id}`;
    const node = waitingPlanNode(state);
    if (node && node.id) {
      const gid = String(state && state.planGraph && state.planGraph.graphId || "");
      return `plan:${gid}:${node.id}`;
    }
    return "";
  }
  function userReminder(state, guard) {
    const nudges = drainUserPrompts(state);
    if (!nudges.length) return "";
    guard.reset();
    return formatUserReminderMessage(nudges, { waitingFor: state.planGraph && state.planGraph.waitingFor || null }) || "";
  }
  function mailbox(state, messages, guard) {
    const drained = drainAgentMailboxForTurn(state);
    if (!drained.text) return false;
    guard.reset();
    messages.push({ role: "user", content: drained.text });
    return true;
  }
  function continuationKey(state) {
    const waitingId = String(state.planGraph && state.planGraph.waitingFor && state.planGraph.waitingFor.id || "");
    if (waitingId) return `plan:${waitingId}`;
    const runs = listTaskRunsAwaitingModel(state);
    return runs.length ? `task:${runs.map((run) => run.id).sort().join(",")}` : "mailbox";
  }
  return {
    initializeState(state) {
      const next = state && typeof state === "object" ? state : emptyExecutionState();
      if (typeof next.planMode !== "boolean") next.planMode = false;
      ensurePendingUserPrompts(next);
      return next;
    },
    prepareTurn({ executionState: state, messages, loopGuard }) {
      if (shouldIsolateTaskFocusTurn(state)) {
        const drained = drainAgentMailboxForTurn(state);
        const nudge = userReminder(state, loopGuard);
        if (drained.events && drained.events.length) loopGuard.reset();
        const focusKey = resolveFocusKey(state);
        const existing = isolatedEpisodes.get(messages);
        if (existing && existing.focusKey === focusKey && messages.length > existing.startOffset) {
          const extra = [drained.text, nudge].filter(Boolean).join("\n\n");
          if (extra) messages.push({ role: "user", content: extra });
          return [existing.seedMessage, ...messages.slice(existing.startOffset)];
        }
        const built = buildIsolatedTaskFocusTurn(state, { mailboxEvents: drained.events || [], userNudge: nudge });
        const seedMessage = built.messages[0];
        isolatedEpisodes.set(messages, {
          focusKey,
          startOffset: messages.length,
          seedMessage,
        });
        return [seedMessage];
      }
      isolatedEpisodes.delete(messages);
      const nudge = userReminder(state, loopGuard);
      if (nudge) messages.push({ role: "user", content: nudge, durableUserPrompt: true });
      mailbox(state, messages, loopGuard);
      return messages;
    },
    continuationKey: ({ executionState }) => continuationKey(executionState),
    continueAfterFinal({ executionState: state, messages, loopGuard }) {
      isolatedEpisodes.delete(messages);
      const nudge = userReminder(state, loopGuard);
      if (nudge) {
        messages.push({ role: "user", content: nudge, durableUserPrompt: true });
        return true;
      }
      if (shouldIsolateTaskFocusTurn(state) || shouldAutoContinueForTaskWake(state)) return true;
      if (mailbox(state, messages, loopGuard)) return true;
      if (shouldAutoContinuePlan(state)) {
        const reminder = buildPlanAutoContinueReminder(state);
        if (reminder) {
          messages.push({ role: "user", content: reminder });
          return true;
        }
      }
      return false;
    },
    legacyCommand(text) {
      const sideEffects = parseStructuredSideEffects(text);
      const args = sideEffects ? normalizePlanGraphCommand(sideEffects) : null;
      return args ? {
        tool: "plan_graph", args, resultType: "plan_graph_result",
        origin: { kind: "legacy_side_effect", source: args.source || "legacy" },
      } : null;
    },
    validateBatch(calls) {
      const names = calls.map((call) => String(call.name || "").toLowerCase());
      if (names.some((name) => CONTROL_TOOLS.has(name)) && names.some((name) => DATA_TOOLS.has(name))) {
        return { ok: false, status: "rejected", code: "MIXED_PLAN_AND_DATA_TOOLS", error: "Do not mix plan_graph/task_run with data-plane tools in the same turn" };
      }
      if (names.includes("ask_user") && calls.length > 1) {
        return { ok: false, status: "rejected", code: "ASK_USER_MUST_BE_ALONE", error: "ask_user must be the only tool call in the turn" };
      }
      return null;
    },
    validateTool(name, state) {
      if (SIDE_EFFECT_DATA_TOOLS.has(name) && activePlanRequiresExpansion(state.planGraph)) {
        return { ok: false, status: "rejected", errors: [{ code: "ACTIVE_PLAN_REQUIRES_EXPANSION", message: "Active plan is waiting on a task; use plan_graph expand_node or control.complete_task instead of direct tools" }] };
      }
      if (planModeBlocksDirectTool(name, state)) {
        return { ok: false, status: "rejected", errors: [{ code: "PLAN_MODE_BLOCKS_SIDE_EFFECT", message: "Plan mode is on; use plan_graph for write/edit/bash, or ask the user to /plan off" }] };
      }
      const lease = checkWriteAllowed(state, { tool: name, originKind: "agent_loop" });
      return lease.ok ? null : { ok: false, status: "rejected", errors: [{ code: lease.code || "WORKSPACE_WRITE_LEASE_HELD", message: lease.message || "Workspace write lease held by an active TaskRun", owner: lease.owner || null }] };
    },
    onDeferred({ executionState, resume, provider }) {
      const interaction = getPendingUserInteraction(executionState);
      if (interaction) interaction.resume = {
        ...(interaction.resume || {}), ...resume, mode: "ask_user",
        transport: provider === "anthropic" ? "anthropic-messages" : "openai-chat",
      };
    },
    pendingInteraction: (state) => hasPendingUserInteraction(state) ? getPendingUserInteraction(state) : null,
    sanitizeResult: sanitizeToolResultForModel,
  };
}

function createPlanningCapability() {
  return {
    id: "planning", version: "1.0", requires: { capabilities: ["coding"] },
    tools: buildCoreToolSpecs().filter((spec) => CONTROL_TOOLS.has(spec.function.name) || spec.function.name === "ask_user").map(({ function: tool }) => ({
      name: tool.name, description: tool.description, inputSchema: tool.parameters,
      permissions: [tool.name === "ask_user" ? "interaction.request" : "execution.control"],
      deferable: tool.name === "ask_user", tight: tool.name === "plan_graph",
      handler: (args, context) => runCoreToolAsync({ ...context, tool: tool.name, args }),
    })),
    policy: createPlanningPolicy(),
  };
}

module.exports = { createPlanningCapability, createPlanningPolicy };
