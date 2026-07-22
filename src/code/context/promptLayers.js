"use strict";

const {
  getIdentitySection,
} = require("../../agents/prompts/native/identity");
const {
  getSystemSection,
} = require("../../agents/prompts/native/system");
const {
  getDoingTasksSection,
} = require("../../agents/prompts/native/tasks");
const {
  getActionsSection,
} = require("../../agents/prompts/native/actions");
const {
  getSafetySection,
} = require("../../agents/prompts/native/safety");
const {
  getOutputEfficiencySection,
} = require("../../agents/prompts/native/efficiency");
const {
  getUfooIntegrationSection,
} = require("../../agents/prompts/native/ufoo");
const {
  getSessionStableEnvironmentSection,
  getTurnDynamicEnvironmentSection,
} = require("../../agents/prompts/native/environment");
const {
  listUcodeSkills,
  renderSkillsSection,
} = require("../skills");
const { hashContent } = require("./artifacts");

const PROMPT_VERSION = "native-v7";

function buildImmutablePrefix() {
  return [
    `promptVersion: ${PROMPT_VERSION}`,
    getIdentitySection(),
    getSystemSection(),
    getDoingTasksSection(),
    getActionsSection(),
    getSafetySection(),
    getOutputEfficiencySection(),
    [
      "Tool calling grammar:",
      "- Use read, write, edit, bash, and artifact_read for direct, single-goal text work, even when it takes several tool calls.",
      "- Use read_image to load workspace png/jpeg/gif/webp images for vision. Do not use read on binary images. Vision is attached for the active model call only; call read_image again if you need the image later.",
      "- TaskRuns are orthogonal to Plan Mode. A TaskRun does not require Plan Mode or a plan_graph. Use task_run operation=start with an objective for a standalone single-point TaskRun; it starts asynchronously and returns immediately.",
      "- On complex or multi-goal requests, automatically decompose into concrete sub-objectives and start TaskRun(s) via task_run. Prefer task_run for independent or loosely coupled tracks; use plan_graph only when you need durable dependencies, checkpoints, or a shared executable plan.",
      "- Use plan_graph for durable graph structure: create, patch, inspect, cancel_graph, and control. Graph-bound TaskRuns use plan_graph control.start_task on execution.kind=task_loop nodes.",
      "- Plan Mode is a runtime posture for the Agent Loop, not an agent tool. While Plan Mode is ON, direct write, edit, and bash calls from the Agent Loop are blocked; read, read_image, and artifact_read remain available. TaskRuns still run independently of Plan Mode.",
      "- In the Agent Loop, plan_graph operation=create automatically enables Plan Mode. The user may also use /plan on or /plan off.",
      "- Turning Plan Mode off does not cancel an existing graph or running TaskRuns. Cancel with task_run (standalone) or plan_graph operation=cancel_graph / control.cancel_task (graph-bound).",
      "- When the user enables Plan Mode and no active graph exists, create a plan_graph before performing side effects.",
      "- After an accepted plan_graph create or patch, Runtime automatically advances ready tool nodes. Never invent or request an execute_graph tool.",
      "- Do not call plan_graph or task_run together with read, read_image, write, edit, bash, or artifact_read in the same assistant turn.",
      "- When an active graph is waiting on a task, advance that node through plan_graph instead of bypassing it with direct workspace tools: use patch.expand_node for execution.kind=expand, control.complete_task (nodeId) for execution.kind=inline_llm, or control.start_task for execution.kind=task_loop.",
      "- Do not end a turn with text only while the plan is still waiting on a task; expand, start, or complete that node. Runtime will auto-continue if you stop early, but prefer advancing in the same turn.",
      "- control.complete_task with nodeId completes a waiting_llm inline_llm task for the current Graph owner. control.complete_task with taskRunId (or task_run complete) is reserved for the owning TaskLoop. Do not directly complete expand or aggregate tasks.",
      "- While Plan Mode is ON, workspace mutations must be represented as plan_graph tool nodes or performed inside a running TaskRun/task_loop.",
      "- Treat a User reminder as the latest user instruction. Reconcile it before continuing from tool results. If it is compatible with the active plan, resume the waiting plan node; otherwise patch, cancel, or replan first.",
      "- TaskLoops do not consume User reminders. The Agent Loop is woken by runtime task_started, task_succeeded, task_failed, and task_cancelled events.",
      "- Runtime enforces TaskRun concurrency limits and workspace write leases. Direct Agent write, edit, or bash calls may be rejected while writing TaskRuns are active.",
      "- Tool results may contain an artifactId. Use artifact_read to hydrate raw stored output or a slice of it; use read for workspace text paths; use read_image for workspace images.",
      "- Use ask_user only when user input is required to proceed. It must be the only tool call in the turn. Use kind=approval for yes/no confirmation, kind=choice for numbered options, and kind=chat for free text.",
      "- The answer to ask_user is returned only as that tool's result, not as a separate user message or pending User reminder. Continue from the returned answer and do not repeat the question.",
      "- ask_user is available only to the Agent Loop. It pauses the Agent Loop, but running TaskRuns continue unless explicitly cancelled.",
      "- Prefer structured argument references when passing upstream node outputs or artifacts into downstream tool arguments. Use string templates only when string interpolation is required, and reference only existing upstream nodes.",
      "State commit schema (optional at segment end):",
      '{"stateCommit":{"factsAdd":[],"hypothesesUpdate":[],"decisionsAdd":[],"questionsClose":[],"nextObjective":""},"contextPlan":{"retainRaw":[],"retainRegions":[],"summarize":[],"evict":[],"rehydrateNext":[]}}',
    ].join("\n"),
  ].join("\n\n");
}

function buildSkillCatalogVersion(skills = []) {
  const names = (Array.isArray(skills) ? skills : [])
    .map((s) => `${s.name}:${s.path}`)
    .sort()
    .join("|");
  return hashContent(names || "empty");
}

function buildSessionStablePrefix({
  workspaceRoot = "",
  provider = "",
  model = "",
  sessionStableExtras = "",
} = {}) {
  const root = workspaceRoot || process.cwd();
  const outcome = listUcodeSkills({ workspaceRoot: root });
  const catalogVersion = buildSkillCatalogVersion(outcome.skills);
  const parts = [
    getUfooIntegrationSection(),
    getSessionStableEnvironmentSection({ workspaceRoot: root, provider, model }),
    renderSkillsSection(outcome.skills),
    `skillCatalogVersion: ${catalogVersion}`,
  ];
  if (sessionStableExtras) parts.push(String(sessionStableExtras).trim());
  return parts.filter(Boolean).join("\n\n");
}

function buildLayeredSystemPrompt({
  workspaceRoot = "",
  model = "",
  provider = "",
  appendSystemPrompt = "",
  overrideSystemPrompt = "",
  epochDynamic = "",
  turnDynamic = "",
  sessionStableExtras = "",
} = {}) {
  if (overrideSystemPrompt) {
    return {
      blocks: [{ layer: "override", text: overrideSystemPrompt, cacheable: false }],
      flatText: overrideSystemPrompt,
    };
  }

  const immutable = buildImmutablePrefix();
  const sessionStable = buildSessionStablePrefix({
    workspaceRoot,
    provider,
    model,
    sessionStableExtras,
  });
  const epochText = String(epochDynamic || "").trim();
  const turnParts = [
    getTurnDynamicEnvironmentSection({ workspaceRoot: workspaceRoot || process.cwd() }),
    String(turnDynamic || "").trim(),
    String(appendSystemPrompt || "").trim(),
  ].filter(Boolean);

  const blocks = [
    { layer: "immutable", text: immutable, cacheable: true },
    { layer: "sessionStable", text: sessionStable, cacheable: true },
  ];
  if (epochText) {
    blocks.push({
      layer: "epoch",
      text: epochText,
      cacheable: true,
    });
  }
  if (turnParts.length > 0) {
    blocks.push({
      layer: "turnDynamic",
      text: turnParts.join("\n\n"),
      cacheable: false,
    });
  }

  return {
    blocks,
    flatText: blocks.map((b) => b.text).filter(Boolean).join("\n\n"),
  };
}

function systemBlocksToAnthropicPayload(blocks = []) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.text);
  const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };
  // Place cache breakpoints on every cacheable layer so Anthropic can reuse
  // Immutable → SessionStable → Epoch prefixes independently. Turn-dynamic
  // never gets cache_control.
  return list.map((block) => {
    const entry = { type: "text", text: block.text };
    if (block.cacheable) entry.cache_control = { ...ANTHROPIC_CACHE_CONTROL };
    return entry;
  });
}

module.exports = {
  PROMPT_VERSION,
  buildImmutablePrefix,
  buildSessionStablePrefix,
  buildLayeredSystemPrompt,
  systemBlocksToAnthropicPayload,
};
