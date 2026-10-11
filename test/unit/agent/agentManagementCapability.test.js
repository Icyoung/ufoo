"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRuntimeStore, composeCapabilities } = require("../../../src/agents/runtime");
const { createAgentManagementService } = require("../../../src/agents/capabilities/agentManagement/service");
const { createAgentManagementCapability } = require("../../../src/agents/capabilities/agentManagement");
const { createTaskReportsCapability } = require("../../../src/agents/capabilities/taskReports");
const { routeAgentHandler } = require("../../../src/tools/handlers/routeAgent");
const { getToolDefinition, assertToolAllowedForCallerTier } = require("../../../src/tools");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

describe("agent management and report capabilities", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-management-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  function service(ports = {}) {
    return createAgentManagementService({ store: createRuntimeStore({ workspaceRoot: root, namespace: "main-control", sessionId: "control" }),
      launch: jest.fn().mockResolvedValue({ ok: true, ops_results: [{ ok: true, subscriber_ids: ["codex:worker"] }] }),
      dispatch: jest.fn().mockResolvedValue({ ok: true, seq: 42 }), ...ports });
  }
  const args = { command_id: "delegate-1", agent: "codex", objective: "fix the parser", acceptance_criteria: ["parser test passes"] };
  test("invalid new nicknames cause a correctable result before effects; corrected creation is dispatched with trace context", async () => {
    const launch = jest.fn().mockResolvedValue({ ok: true, agent_id: "codex:worker" });
    const dispatch = jest.fn().mockResolvedValue({ ok: true, seq: 42 });
    const manager = service({ launch, dispatch, resolveTarget: () => "" });
    expect(await manager.delegate({ ...args, target: "new-worker" })).toMatchObject({ ok: false, code: "invalid_target" });
    expect(manager.snapshot().tasks).toEqual({});
    expect(launch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const result = await manager.delegate(args, { traceId: "root", taskRunId: "parent", requestId: "request", sessionId: "main" });
    expect(result.ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].runtimeContext).toMatchObject({ traceId: "root", taskId: result.task.taskId, parentTaskRunId: "parent", parentRequestId: "request" });
  });
  test("a confirmed launch failure remains terminal and cannot be mistaken for a queued task", async () => {
    const launch = jest.fn().mockResolvedValue({ ok: false, code: "launch_rejected", error: "unavailable" });
    const manager = service({ launch });
    const result = await manager.delegate(args);
    expect(result).toMatchObject({ ok: false, code: "launch_rejected" });
    expect(manager.snapshot().tasks[result.taskId].status).toBe("failed");
    expect(await manager.delegate(args)).toMatchObject({ ok: false, code: "launch_rejected" });
    expect(launch).toHaveBeenCalledTimes(1);
  });
  test("binds launch and dispatch once with explicit parent and worker IDs", async () => {
    const launch = jest.fn().mockResolvedValue({ ok: true, agent_id: "codex:worker" });
    const dispatch = jest.fn().mockResolvedValue({ ok: true, seq: 42 });
    const manager = service({ launch, dispatch });
    const result = await manager.delegate(args, { taskRunId: "parent-task", sessionId: "main-session" });
    expect(result.task).toMatchObject({ workerId: "codex:worker", parentTaskRunId: "parent-task", parentSessionId: "main-session", status: "queued" });
    expect(dispatch.mock.calls[0][0]).toMatchObject({ target: "codex:worker", taskId: result.task.taskId });
    expect(dispatch.mock.calls[0][0].message).toContain(result.task.taskId);
    expect(dispatch.mock.calls[0][0].message).toContain("1-4 short lines, at most 600 characters");
    expect(dispatch.mock.calls[0][0].message).toContain("parser test passes");
    expect(dispatch.mock.calls[0][0].message).toContain("required acceptance evidence");
    await service({ launch, dispatch }).delegate(args);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  test("a failed dispatch retry never launches another worker or blindly replays delivery", async () => {
    const launch = jest.fn().mockResolvedValue({ ok: true, agent_id: "codex:worker" });
    const dispatch = jest.fn().mockRejectedValue(new Error("queue receipt lost"));
    const manager = service({ launch, dispatch });
    await expect(manager.delegate(args)).rejects.toThrow("queue receipt lost");
    expect(await service({ launch, dispatch }).delegate(args)).toMatchObject({ ok: false, code: "uncertain_effect" });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  test("only mapped terminal reports wake the parent and require evidence before acceptance", async () => {
    const wake = jest.fn().mockResolvedValue({ accepted: true });
    const manager = service({ wake, validateEvidence: (evidence) => evidence.includes("test-call-1") });
    const delegated = await manager.delegate(args, { taskRunId: "parent-task", sessionId: "main-session" });
    const report = { entry_id: "done-1", task_id: delegated.task.taskId, agent_id: "codex:worker", phase: "done", summary: "parser fixed" };
    expect(await manager.report({ ...report, agent_id: "claude:wrong" })).toEqual({ matched: false });
    await manager.report({ ...report, entry_id: "progress-1", phase: "progress" });
    expect(wake).not.toHaveBeenCalled();
    await manager.report(report);
    await manager.report(report);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toMatchObject({ parentTaskRunId: "parent-task", taskId: report.task_id });
    expect(manager.snapshot().tasks[report.task_id].status).toBe("reported");
    expect(manager.accept({ task_id: report.task_id, outcome: "accepted", reason: "looks good" })).toMatchObject({ ok: false, code: "acceptance_required" });
    expect(manager.accept({ task_id: report.task_id, outcome: "accepted", reason: "validated", evidence: ["fabricated"] })).toMatchObject({ ok: false, code: "invalid_evidence" });
    expect(manager.accept({ task_id: report.task_id, outcome: "accepted", reason: "validated parser behavior", evidence: ["test-call-1"] }).task.status).toBe("accepted");
  });
  test("durably retries a report wake after the host was unavailable using the same request ID", async () => {
    const wake = jest.fn().mockRejectedValueOnce(new Error("host restarting")).mockResolvedValue({ accepted: true });
    const manager = service({ wake });
    const { task } = await manager.delegate(args);
    const report = { entry_id: "report-1", task_id: task.taskId, agent_id: task.workerId, phase: "done" };
    await expect(manager.report(report)).rejects.toThrow("host restarting");
    await manager.report(report);
    expect(wake.mock.calls[0][0].requestId).toBe(wake.mock.calls[1][0].requestId);
    expect(manager.snapshot().tasks[task.taskId].pendingWake).toBe("");
  });
  test("shared controller schemas preserve worker authorization and do not advertise absent host ports", async () => {
    expect(() => assertToolAllowedForCallerTier("delegate_task", "worker")).toThrow("not allowed");
    await expect(getToolDefinition("delegate_task").handler({ caller_tier: "worker" }, args)).rejects.toMatchObject({ code: "forbidden_caller_tier" });
    const host = { coordination: {}, grantedPermissions: ["coordination.read", "agents.manage"] };
    const caps = [createAgentManagementCapability(host), createTaskReportsCapability(host)];
    expect(composeCapabilities({ host, capabilities: caps }).tools.names()).not.toContain("delegate_task");
    host.coordination.agentManagement = service();
    host.grantedPermissions.push("tasks.accept");
    const tools = composeCapabilities({ host, capabilities: [createAgentManagementCapability(host), createTaskReportsCapability(host)] }).tools;
    expect(tools.names()).toContain("delegate_task");
    expect(tools.names()).toContain("accept_task");
  });
  test("routing is a read-only project preview that respects explicit references", () => {
    const file = getUfooPaths(root).agentsFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agents: {
      "codex:a": { agent_type: "codex", nickname: "parser", role: "parser coding", status: "active", activity_state: "working" },
      "claude:b": { agent_type: "claude-code", nickname: "reviewer", role: "review", status: "active", activity_state: "idle" },
      "codex:dead": { agent_type: "codex", nickname: "dead", status: "inactive" },
    } }));
    const before = fs.readFileSync(file, "utf8");
    expect(routeAgentHandler({ projectRoot: root }, { request: "fix parser" }).target).toBe("codex:a");
    expect(routeAgentHandler({ projectRoot: root }, { request: "fix parser", context_hint: "reviewer" }).target).toBe("claude:b");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  test("group retries reuse a receipt while another request may use the same command label", async () => {
    const manager = service();
    const runGroup = jest.fn().mockResolvedValue({ ok: true });
    const ctx = { caller_tier: "controller", agentManagement: manager, groups: { runGroup } };
    const command = { operation: "start", command_id: "start-review", target: "review" };
    const tool = getToolDefinition("manage_group");
    await tool.handler({ ...ctx, requestId: "user-1" }, command);
    await tool.handler({ ...ctx, requestId: "user-1" }, command);
    await tool.handler({ ...ctx, requestId: "user-2" }, command);
    expect(runGroup).toHaveBeenCalledTimes(2);
    expect(runGroup.mock.calls[0][0].instance).not.toBe(runGroup.mock.calls[1][0].instance);
  });
  test.each(["grok", "agy", "kimi"])("delegation rejects unsupported internal worker %s before recording effects", async (agent) => {
    const launch = jest.fn(); const dispatch = jest.fn();
    const management = service({ launch, dispatch });
    expect(await management.delegate({ ...args, agent })).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(launch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    expect(management.snapshot().tasks).toEqual({});
  });

});
