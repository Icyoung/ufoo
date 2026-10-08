"use strict";

const fs = require("fs");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { stableStringify } = require("../../agents/runtime/core/stableJson");
const { spawnSync } = require("child_process");
const { createAgentRuntime, createRuntimeStore, createTaskScheduler } = require("../../agents/runtime");
const { createMainCapabilities, createGlobalCapabilities } = require("../../agents/capabilities");
const { createCodingCapability } = require("../../agents/capabilities/coding");
const { createMainPlanningCapability } = require("../../agents/capabilities/planning/main");
const { createSkillsCapability } = require("../../agents/capabilities/skills");
const { createAgentManagementService } = require("../../agents/capabilities/agentManagement/service");
const { executeControllerTool } = require("../../agents/controller/controllerToolExecutor");
const { TOOL_PERMISSIONS } = require("../../agents/capabilities/coordination");
const { getNativeTransport } = require("../../agents/providers/nativeTransport");
const { resolveRuntimeConfig } = require("../../agents/providers/runtimeConfig");
const { resolveUpstreamRuntime, normalizeProvider } = require("../../agents/providers/upstreamTransport");
const { loadConfig, defaultAgentModelForProvider } = require("../../config");
const mainProfile = require("../../agents/profiles/main");
const globalProfile = require("../../agents/profiles/globalRouter");
const { buildMainAgentPrompt, buildCodingTaskPrompt } = require("../../agents/prompts/mainAgent");
const { resolveUserInteraction, parseUserInteractionInput } = require("../../code/context/userInteraction");
const { materializeAnswerToolResult } = require("../../code/protocol");
const { createWorkspaceAccess } = require("../../coordination/state/workspaceAccess");
const { buildCachedMemoryPrefix } = require("../../coordination/memory");
const { readBusSummaryHandler } = require("../../tools/handlers/readBusSummary");
const { isInternalAgentMeta } = require("../contracts/agentMode");
const { getUfooPaths } = require("../../coordination/state/paths");
const { loadAgentsData } = require("../../coordination/state/agentsStore");
const { readOpenDecisionsHandler } = require("../../tools/handlers/readOpenDecisions");
const { listProjectRuntimes, isGlobalControllerProjectRoot } = require("../projects");
const { canonicalProjectRoot, buildProjectId } = require("../projects/projectId");
const { resolveWorkspacePath } = require("../../code/tools/common");
const { listControllerInboxEntries } = require("../../coordination/report/store");
const { readControllerSummary } = require("../../coordination/history/controllerSummary");
const { redactSecrets } = require("../privacy/redactor");

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const safeId = (value) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(value || "");
const MAIN_GRANTS = ["workspace.read", "workspace.write", "workspace.execute", "interaction.request", "coordination.read", "coordination.write", "agents.manage", "memory.write", "tasks.accept", "tasks.execute", "groups.manage", "schedules.manage"];

function resolveTaskWorkspace(projectRoot, requested = "") {
  const target = canonicalProjectRoot(requested || projectRoot);
  if (target === projectRoot) return target;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, encoding: "utf8", timeout: 3000 });
  if (top.status !== 0 || canonicalProjectRoot(top.stdout.trim()) !== projectRoot) throw new Error("task workspace is outside the project grant");
  const result = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: projectRoot, encoding: "utf8", timeout: 3000 });
  const roots = result.status === 0 ? result.stdout.split("\0").filter((item) => item.startsWith("worktree ")).map((item) => canonicalProjectRoot(item.slice(9))) : [];
  if (!roots.includes(target)) throw new Error("task workspace must be a verified worktree of this project");
  return target;
}

/** Project-owned runtime instances. A client disconnect never owns their cancellation. */
function createAgentHost({ projectRoot, provider, model, ports = {}, onEvent = () => {}, log = () => {},
  resolveProvider = resolveUpstreamRuntime, transportFactory = getNativeTransport, maxConcurrent = 2 } = {}) {
  const root = canonicalProjectRoot(projectRoot);
  const projectId = buildProjectId(root);
  const global = isGlobalControllerProjectRoot(root);
  const sessions = new Map();
  const children = new Map();
  const stores = new Map();
  const scheduler = createTaskScheduler({ maxConcurrent });
  const compatibilityScheduler = createTaskScheduler({ maxConcurrent: 1 });
  const conversationScheduler = createTaskScheduler({ maxConcurrent: 2, maxQueued: 128 });
  const control = createRuntimeStore({ workspaceRoot: root, namespace: "main-control", sessionId: "control", redact: redactSecrets });
  let closed = false;
  const publicEvent = (event) => {
    const safe = { ...event };
    delete safe.args;
    if (safe.result) safe.result = safe.type === "tool.completed"
      ? { ok: safe.result.ok, code: safe.result.code, error: safe.result.error, toolCallId: safe.toolCallId }
      : { text: safe.result.text, usage: safe.result.usage, executionState: { pendingUserInteraction: safe.result.executionState?.pendingUserInteraction || null } };
    return redactSecrets({ version: 1, projectId, projectRoot: root, agentId: "ufoo-agent", global, ...safe });
  };
  const publish = (event) => { try { const pending = onEvent(publicEvent(event)); if (pending && pending.catch) pending.catch((error) => log(error.message)); } catch (error) { log(error.message); } };
  const jobs = () => control.read().capabilityState["task-execution"]?.value?.jobs || {};
  function updateJobs(mutator) {
    control.transaction((state) => {
      const value = state.capabilityState["task-execution"]?.value || { jobs: {} };
      mutator(value.jobs);
      return [{ type: "capability.state_committed", capabilityId: "task-execution", version: 1, value }];
    });
  }
  function validateEvidence(evidence, context, after = "") {
    const store = stores.get(context.sessionId);
    return Array.isArray(evidence) && evidence.length > 0 && store && evidence.every((id) => store.events().some((event) =>
      event.type === "tool.completed" && event.toolCallId === id && event.taskRunId === context.taskRunId
      && event.toolName === "bash" && event.result?.ok === true && (!after || event.time >= after)));
  }
  const workspaceAccess = createWorkspaceAccess({ projectRoot: root, externalWriters(context) {
    const tasks = Object.values(management.snapshot().tasks);
    const pending = tasks.filter((task) => ["planning", "awaiting_registration"].includes(task.status) && !task.workerId).map((task) => task.taskId);
    return [...pending, ...readBusSummaryHandler({ projectRoot: root, internalAgentsOnly: true }).active_agents.filter((agent) => {
      if (agent.id === context.agentId || agent.id === "ufoo-agent") return false;
      const assigned = tasks.filter((task) => task.workerId === agent.id);
      return !assigned.length || assigned.some((task) => ["planning", "queued", "delivered", "delivery_uncertain", "running"].includes(task.status))
        || ["working", "starting", "running"].includes(agent.activity_state);
    }).map((agent) => agent.id)];
  } });
  const management = createAgentManagementService({ store: control,
    resolveTarget(target) {
      const matches = readBusSummaryHandler({ projectRoot: root, internalAgentsOnly: true }).active_agents.filter((agent) => agent.id !== "ufoo-agent"
        && [agent.id, agent.nickname, agent.scoped_nickname, agent.display_nickname].includes(target));
      return matches.length === 1 ? matches[0].id : "";
    },
    launch: async (args) => {
      const rows = await coordinatedOps(root, [{ action: "launch", ...args }], ports.processManager);
      return { ok: Array.isArray(rows) && rows.some((row) => row.action === "launch" && row.ok !== false), ops_results: rows };
    },
    dispatch: async ({ target, message }) => {
      const receipts = await ports.dispatchMessages(root, [{ target, message, source: "ufoo-agent", injection_mode: "immediate" }]);
      if (ports.markPending) ports.markPending(target);
      return { ok: true, delivery_status: "queued", target, receipt: receipts?.[0] || null };
    },
    wake: (request) => getSession(Object.values(management.snapshot().tasks).find((task) => task.taskId === request.taskId)?.parentSessionId || "main-default").submit(request),
    emit: (event) => { const state = control.append(event); publish({ ...event, sessionId: "control", sequence: state.sequence }); },
    validateEvidence(evidence, task, context) {
      return validateEvidence(evidence, context, task.report.ts);
    },
  });
  const taskPort = { async execute(args, context = {}) {
    if (global && args.operation !== "list") throw new Error("global router has no coding task grant");
    if (args.operation === "list") return { ok: true, tasks: Object.values(jobs()).map(publicChild) };
    if (args.operation === "start") {
      if (!safeId(args.command_id) || !String(args.objective || "").trim()) throw new Error("task start requires command_id and objective");
      const scope = context.requestId ? `task-${hash(`${context.requestId}:${args.command_id}`)}` : args.command_id;
      const id = `child-${hash(scope)}`;
      const workspaceRoot = resolveTaskWorkspace(root, args.workspace);
      updateJobs((items) => {
        const fingerprint = hash(stableStringify(args));
        if (items[id] && items[id].fingerprint !== fingerprint) throw new Error("task command conflicts");
        if (!items[id]) items[id] = { id, requestId: scope, fingerprint, objective: args.objective, workspaceRoot,
          readOnly: args.read_only === true, parentSessionId: context.sessionId, parentTaskRunId: context.taskRunId, status: "queued" };
      });
      const runtime = getChild(jobs()[id]);
      const accepted = runtime.submit({ requestId: scope, text: args.objective, resourceKey: args.read_only ? "" : workspaceRoot });
      updateJobs((items) => { items[id].taskRunId = accepted.taskRunId; });
      return { ok: true, ...accepted, task: publicChild(jobs()[id]) };
    }
    const job = Object.values(jobs()).find((item) => item.taskRunId === args.task_run_id || item.id === args.task_run_id);
    if (!job && args.operation === "inspect") {
      for (const [sessionId, runtime] of sessions) {
        const task = runtime.snapshot().tasks[args.task_run_id];
        if (task) return { ok: true, task: { taskRunId: task.taskRunId, sessionId, status: task.status, error: task.error,
          summary: task.result?.text?.slice(-6000) || "", effects: task.effects, interaction: task.result?.executionState?.pendingUserInteraction || null } };
      }
    }
    if (!job) throw new Error("task not found in this project");
    const runtime = getChild(job);
    if (args.operation === "cancel") return { ok: true, ...runtime.cancel({ taskRunId: job.taskRunId, reason: args.reason }) };
    if (["accept", "reject"].includes(args.operation)) {
      const task = runtime.snapshot().tasks[job.taskRunId];
      if (job.review === "accepted") return { ok: true, task: publicChild(job) };
      if (task?.status !== "completed" || !String(args.reason || "").trim()) throw new Error("review requires a completed task and a reason");
      if (args.operation === "accept" && !validateEvidence(args.evidence, context, job.completedAt)) throw new Error("acceptance requires successful main validation toolCallIds after completion");
      updateJobs((items) => { items[job.id].review = args.operation === "accept" ? "accepted" : "rejected";
        items[job.id].reviewReason = args.reason; items[job.id].evidence = args.evidence || []; });
    }
    return { ok: true, task: publicChild(jobs()[job.id]) };
  } };
  async function coordinatedOps(project, ops, manager) {
    ops = ops.map((op) => op.action === "launch" ? { ...op, internal_only: true } : op);
    if (!ops.some((op) => op.action === "launch")) return ports.handleOps(project, ops, manager);
    const ownerId = `launch-${randomUUID()}`;
    const result = await workspaceAccess.leases.run({ key: root, ownerId }, () => ports.handleOps(project, ops, manager, { leaseOwnerId: ownerId }));
    if (result?.code === "workspace_busy") throw Object.assign(new Error("coding task owns this workspace; launch after it finishes or use an isolated worktree"), { code: "workspace_busy" });
    return result;
  }
  function publicChild(job) {
    const runtime = children.get(job.id);
    const task = runtime && runtime.snapshot().tasks[job.taskRunId];
    return { id: job.id, taskRunId: job.taskRunId, objective: job.objective, workspaceRoot: job.workspaceRoot,
      status: job.review || task?.status || job.status, executionStatus: task?.status || job.status,
      sessionId: job.id, interaction: task?.result?.executionState?.pendingUserInteraction || null,
      reviewReason: job.reviewReason || "", summary: task?.result?.text?.slice(-6000) || job.summary || "", error: task?.error || "" };
  }
  function makeRuntime({ sessionId, namespace, profile, capabilities, host, workspaceRoot = root, child = null }) {
    const productConfig = loadConfig(root);
    const store = createRuntimeStore({ workspaceRoot: root, namespace, sessionId, redact: redactSecrets });
    const previousBinding = store.read().binding;
    const configuredProvider = normalizeProvider(provider || productConfig.agentProvider || "ucode");
    const useCodingConfig = previousBinding?.codingConfig ?? configuredProvider === "ucode";
    const selectedProvider = useCodingConfig ? "" : previousBinding?.provider || configuredProvider;
    const selectedModel = previousBinding?.model || model || (useCodingConfig ? "" : productConfig.agentModel || defaultAgentModelForProvider(selectedProvider));
    const config = resolveRuntimeConfig({ workspaceRoot: root, provider: selectedProvider, model: selectedModel, useCodingConfig });
    const transport = transportFactory(config.transport);
    const binding = { provider: selectedProvider || config.provider, model: config.model, transport: config.transport, codingConfig: useCodingConfig };
    store.transaction((state) => {
      if (state.binding && (state.binding.provider !== binding.provider || state.binding.transport !== binding.transport)) throw Object.assign(new Error("coding gateway changed; restore its configuration or use /session new"), { code: "session_provider_pinned" });
      return state.binding ? [] : [{ type: "runtime.binding", binding }];
    });
    stores.set(sessionId, store);
    let runtime;
    const prepare = async (request, task, resumed = false) => {
      const resolved = useCodingConfig && config.apiKey && config.apiKeySource !== "kimi-credential"
        ? { ...config, auth: { apiKey: config.apiKey } }
        : await resolveProvider({ projectRoot: root, provider: selectedProvider || config.provider, model: config.model });
      if (useCodingConfig) resolved.baseUrl = config.baseUrl;
      const expected = resolved.transport === "codex-responses" ? "openai-responses" : resolved.transport;
      if (expected !== config.transport) throw new Error("provider transport changed; start a new session");
      const context = child ? [] : [readBusSummaryHandler({ projectRoot: root, internalAgentsOnly: true }), readOpenDecisionsHandler({ projectRoot: root }, { limit: 20 }),
        { memory: buildCachedMemoryPrefix(root, { limit: 30, maxTokens: 1500 }).prefix || "" }, { delegatedTasks: Object.values(management.snapshot().tasks).slice(-30) }];
      if (!child) {
        const registered = loadAgentsData(getUfooPaths(root).agentsFile).agents;
        context.push({ requestMeta: request.requestMeta || {}, reports: listControllerInboxEntries(root, "ufoo-agent", { num: 30 })
          .filter((report) => isInternalAgentMeta(registered[report.agent_id])) });
      }
      if (!child) context.push(readControllerSummary(root));
      const sources = await runtime.buildContext({ workspaceRoot, prompt: request.text, promptText: request.text });
      const skillSource = sources.find((source) => source.capabilityId === "skills")?.value;
      const skillBlocks = (skillSource?.blocks || []).join("\n\n").slice(0, 65536);
      context.push(...sources.filter((source) => source.capabilityId !== "skills"));
      if (skillSource) context.push({ skills: { active: skillSource.activeSkills, warnings: skillSource.warnings } });
      const instructionFile = path.join(workspaceRoot, "AGENTS.md");
      const instructions = fs.existsSync(instructionFile) ? fs.readFileSync(instructionFile, "utf8").slice(0, 16000) : "";
      const history = child ? [] : Object.values(store.read().tasks).filter((item) => item.status === "completed" && item.taskRunId !== task.taskRunId).slice(-8)
        .flatMap((item) => [{ role: "user", content: item.request.text.slice(0, 4000) }, { role: "assistant", content: String(item.result?.text || "").slice(-6000) }]);
      const attachments = (request.attachments || []).map((attachment) => resolveWorkspacePath(workspaceRoot, typeof attachment === "string" ? attachment : attachment.path).resolved);
      return { workspaceRoot, sessionId, projectId, agentId: child ? child.id : "ufoo-agent", artifactNamespace: namespace,
        model: resolved.model, provider: resolved.provider === "claude" ? "anthropic" : resolved.provider,
        baseUrl: resolved.baseUrl, apiKey: resolved.auth?.apiKey || "", requestHeaders: resolved.auth?.headers || {},
        accountId: resolved.credential?.accountId || "", requestProfile: resolved.requestProfile || "",
        prompt: resumed ? "" : request.text + (attachments.length ? `\n\nWorkspace attachments (read with read/read_image): ${JSON.stringify(attachments)}` : ""), historyMessages: history,
        systemPrompt: child ? buildCodingTaskPrompt({ workspaceRoot, instructions, skillBlocks, toolNames: runtime.tools.names() }) : buildMainAgentPrompt({ global, workspaceRoot, skillBlocks, toolNames: runtime.tools.names(), promptSections: runtime.promptSections, context, instructions: global ? "" : instructions }),
        maxRounds: profile.budgets?.maxRounds || (child ? 128 : 64), toolBudget: { maxToolCalls: profile.budgets?.maxToolCalls || (child ? 256 : 128), maxToolErrors: profile.budgets?.maxToolErrors || 20 },
      };
    };
    runtime = createAgentRuntime({ profile, capabilities, transport,
      host: { ...host, projectId, agentId: child ? child.id : "ufoo-agent", sessionStore: store, prepareRequest: prepare,
        validateAnswer(task, answer) {
          const parsed = parseUserInteractionInput(task.result.executionState.pendingUserInteraction, typeof answer === "string" ? answer : JSON.stringify(answer));
          if (!parsed.ok) throw new Error(parsed.error);
        },
        async resumeRequest(task, answer) {
          const previous = JSON.parse(JSON.stringify(task.result));
          const resolved = resolveUserInteraction(previous.executionState, typeof answer === "string" ? answer : JSON.stringify(answer));
          if (!resolved.ok) throw new Error(resolved.error);
          const paired = materializeAnswerToolResult(previous.messages, resolved.resume, resolved.answer);
          if (!paired.ok) throw new Error(paired.error);
          return { ...await prepare(task.request, task, true), historyMessages: previous.messages, executionState: previous.executionState, resume: true };
        },
        eventSink(event) {
          publish({ ...event, sessionId });
          if (child && ["task.completed", "task.failed", "task.cancelled"].includes(event.type)) {
            updateJobs((items) => { const item = items[child.id]; item.status = event.type.split(".")[1]; item.completedAt = event.time || new Date().toISOString(); item.summary = String(event.result?.text || event.error || "").slice(-6000); item.pendingWake = `child-result-${hash(`${child.id}:${event.taskRunId}`)}`; });
            flushChildWakes();
          }
        }, onError: (error) => log(error.message) },
    });
    return runtime;
  }
  function getSession(sessionId = "main-default") {
    if (closed || !safeId(sessionId)) throw new Error("invalid or closed main session");
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const host = { grantedPermissions: global ? ["coordination.read"] : MAIN_GRANTS, workspaceAccess,
      taskScheduler: conversationScheduler,
      projectRouting: { list: () => listProjectRuntimes({ validate: true }) },
      coordination: { ...ports, internalAgentsOnly: true, handleOps: coordinatedOps, projectRoot: root, agentManagement: management, taskScheduler: taskPort } };
    host.coordination.execute = (ctx, call) => {
      const permission = TOOL_PERMISSIONS[call.name];
      const readOnly = ["manage_tasks", "manage_group", "resume_agents", "manage_cron"].includes(call.name)
        && ["list", "ls", "inspect", "status", "validate"].includes(call.arguments.operation);
      const invoke = async () => {
        const result = await executeControllerTool(ctx, call);
        if (result.ok === false && result.error?.code === "tool_execution_failed") throw Object.assign(new Error(result.error.message), { code: "uncertain_effect" });
        return result;
      };
      return permission && permission !== "coordination.read" && !readOnly
        ? management.commands.execute({ commandId: `tool-${hash(stableStringify({ request: ctx.requestId, name: call.name, args: call.arguments }))}`, kind: call.name, args: call.arguments }, invoke)
        : invoke();
    };
    const runtime = makeRuntime({ sessionId, namespace: global ? "global-router" : "main", profile: global ? globalProfile : mainProfile,
      host, capabilities: global ? createGlobalCapabilities(host) : createMainCapabilities(host) });
    sessions.set(sessionId, runtime);
    return runtime;
  }
  function getChild(job) {
    if (children.has(job.id)) return children.get(job.id);
    const grants = job.readOnly ? ["workspace.read"] : ["workspace.read", "workspace.write", "workspace.execute", "interaction.request"];
    const coding = createCodingCapability({ workspaceAccess });
    coding.tools = coding.tools.filter((tool) => tool.permissions.every((permission) => grants.includes(permission)));
    const capabilities = [coding, createSkillsCapability(), ...(job.readOnly ? [] : [createMainPlanningCapability()])];
    const host = { grantedPermissions: grants, taskScheduler: { schedule(options, work) {
      return scheduler.schedule(options, (signal) => job.readOnly ? work(signal)
        : workspaceAccess.runTask({ workspaceRoot: job.workspaceRoot, taskRunId: options.id, signal }, () => work(signal)).then((result) => {
          if (result.ok === false) throw Object.assign(new Error(result.error), { code: result.code });
          return result;
        }));
    } } };
    const runtime = makeRuntime({ sessionId: job.id, namespace: "main-task", profile: { id: job.readOnly ? "coding-read-only" : "coding-task", capabilities: capabilities.map((cap) => cap.id) },
      capabilities, host, workspaceRoot: job.workspaceRoot, child: job });
    children.set(job.id, runtime);
    return runtime;
  }
  function flushChildWakes() {
    for (const job of Object.values(jobs())) {
      if (!job.pendingWake) continue;
      getSession(job.parentSessionId || "main-default").submit({ requestId: job.pendingWake,
        text: `Independent task ${job.taskRunId} is ${job.status}. Summary: ${job.summary}. Review the outcome and continue the parent objective.`, parentTaskRunId: job.parentTaskRunId });
      updateJobs((items) => { if (items[job.id].pendingWake === job.pendingWake) items[job.id].pendingWake = ""; });
    }
  }
  function resolveRuntime(sessionId = "main-default") {
    const job = jobs()[sessionId];
    return job ? getChild(job) : getSession(sessionId);
  }
  return Object.freeze({
    getSession, resolveRuntime, taskPort, management, publicEvent, workspaceAccess, projectRoot: root,
    runCompatibility({ originalPrompt, requestId }, invoke) {
      const commandId = `compat-${hash(requestId)}`;
      return management.commands.execute({ commandId, kind: "controller-compatibility", args: { prompt: originalPrompt } },
        () => compatibilityScheduler.schedule({ id: commandId }, invoke));
    },
    findRuntime({ taskRunId, interactionId, sessionId } = {}) {
      for (const runtime of [...sessions.values(), ...children.values()]) if (Object.values(runtime.snapshot().tasks).some((task) => taskRunId ? task.taskRunId === taskRunId : interactionId && [task.interactionId, task.answeredInteractionId].includes(interactionId))) return runtime;
      return resolveRuntime(sessionId);
    },
    submit: (request, sessionId) => getSession(sessionId).submit(request),
    async runPrompt({ prompt, requestId = randomUUID(), sessionId = "main-default", requestMeta = {} }) {
      const runtime = getSession(sessionId);
      const accepted = runtime.submit({ requestId, text: prompt, requestMeta });
      const task = await runtime.wait(accepted.taskRunId);
      if (["failed", "cancelled", "interrupted"].includes(task.status)) return { ok: false, error: task.error, taskRunId: task.taskRunId };
      let payload = { reply: task.result?.text || "", dispatch: [], ops: [] };
      if (global) {
        try { payload = JSON.parse(payload.reply); } catch { return { ok: false, error: "global router returned invalid JSON" }; }
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.reply !== "string") return { ok: false, error: "global router returned an invalid payload" };
        if (payload.project_route) {
          const target = canonicalProjectRoot(payload.project_route.project_root);
          const registered = listProjectRuntimes({ validate: true }).some((project) => {
            try { return canonicalProjectRoot(project.project_root) === target; } catch { return false; }
          });
          if (!registered || target === root) return { ok: false, error: "global router selected a project outside the registry grant" };
        }
        payload.dispatch = [];
        payload.ops = [];
      }
      payload.runtime = { ...accepted, status: task.status, sessionId, interaction: task.result?.executionState?.pendingUserInteraction || null };
      return { ok: true, payload };
    },
    snapshot: () => ({ sessions: [...sessions].map(([sessionId, runtime]) => ({ sessionId, sequence: runtime.snapshot().sequence,
      tasks: Object.values(runtime.snapshot().tasks).map((task) => ({ taskRunId: task.taskRunId, requestId: task.request.requestId, status: task.status, error: task.error, interaction: task.result?.executionState?.pendingUserInteraction || null })) })),
      children: Object.values(jobs()).map(publicChild), delegated: Object.values(management.snapshot().tasks), scheduler: scheduler.snapshot(), conversations: conversationScheduler.snapshot(), compatibility: compatibilityScheduler.snapshot(),
      uncertainReceipts: Object.values(control.read().commands).filter((command) => command.status === "uncertain").map(({ commandId, kind, time }) => ({ commandId, kind, time })) }),
    async recover() {
      const directory = path.join(root, ".ufoo", "agent", global ? "global-router" : "main", "runtimes");
      if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && safeId(entry.name)) {
          try { getSession(entry.name); } catch (error) { log(`session ${entry.name} recovery: ${error.message}`); }
        }
      }
      for (const job of Object.values(jobs())) {
        try {
          const runtime = getChild(job);
          const accepted = runtime.submit({ requestId: job.requestId, text: job.objective, resourceKey: job.readOnly ? "" : job.workspaceRoot });
          const task = runtime.snapshot().tasks[accepted.taskRunId];
          updateJobs((items) => {
            const item = items[job.id]; item.taskRunId = accepted.taskRunId;
            if (["completed", "failed", "cancelled", "interrupted"].includes(task.status) && item.status !== task.status) {
              item.status = task.status; item.summary = String(task.result?.text || task.error || "").slice(-6000);
              item.completedAt = runtime.events().findLast((event) => event.taskRunId === task.taskRunId && event.type === `task.${task.status}`)?.time || new Date().toISOString();
              item.pendingWake = `child-result-${hash(`${job.id}:${task.taskRunId}`)}`;
            }
          });
        } catch (error) { log(`child ${job.id} recovery: ${error.message}`); }
      }
      for (const report of listControllerInboxEntries(root, "ufoo-agent", { num: 1000 })) await management.report(report);
      await management.flushWakes(); flushChildWakes();
    },
    async close() { closed = true; await Promise.allSettled([...sessions.values(), ...children.values()].map((runtime) => runtime.close())); await scheduler.close(); await conversationScheduler.close(); await compatibilityScheduler.close(); },
  });
}

module.exports = { createAgentHost, resolveTaskWorkspace };
