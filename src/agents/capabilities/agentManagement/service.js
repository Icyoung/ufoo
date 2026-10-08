"use strict";

const { createHash } = require("crypto");
const { createCommandStore } = require("../../runtime");
const { stableStringify } = require("../../runtime/core/stableJson");

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const empty = () => ({ tasks: {} });

/** Project host ports own launching/delivery; this adapter records business associations. */
function createAgentManagementService({ store, launch, dispatch, wake = async () => {}, emit = () => {}, validateEvidence = null, resolveTarget = (target) => target } = {}) {
  const commands = createCommandStore(store);
  const read = () => store.read().capabilityState["agent-management"]?.value || empty();
  function update(mutator) {
    return store.transaction((snapshot) => {
      const state = snapshot.capabilityState["agent-management"]?.value || empty();
      mutator(state);
      return [{ type: "capability.state_committed", capabilityId: "agent-management", version: 1, value: state }];
    });
  }
  async function flushWakes() {
    for (const task of Object.values(read().tasks)) {
      if (!task.pendingWake) continue;
      await wake({ requestId: task.pendingWake, text: `Review delegated task ${task.taskId}. Worker reports ${task.report.phase}. Validate the acceptance criteria and evidence before accepting.`,
        taskId: task.taskId, parentTaskRunId: task.parentTaskRunId, report: task.report, acceptanceCriteria: task.acceptanceCriteria });
      update((state) => { if (state.tasks[task.taskId].pendingWake === task.pendingWake) state.tasks[task.taskId].pendingWake = ""; });
    }
  }
  return Object.freeze({
    commands,
    snapshot: read,
    flushWakes,
    delivery({ subscriber, event, status, errorCode }) {
      const matched = Object.values(read().tasks).find((task) => task.workerId === subscriber && task.dispatchReceipt?.receipt?.seq === event?.seq);
      if (!matched || !["queued", "delivery_uncertain"].includes(matched.status)) return { matched: false };
      const next = status === "ok" ? "delivered" : errorCode === "native_outcome_unknown" ? "delivery_uncertain" : "queued";
      update((state) => { state.tasks[matched.taskId].status = next; });
      emit({ type: next === "delivery_uncertain" ? "delivery.uncertain" : "dispatch.delivered", taskId: matched.taskId, workerId: subscriber, deliveryStatus: next });
      return { matched: true, status: next };
    },
    async delegate(args, context = {}) {
      const id = String(args.command_id || "");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(id)) throw new Error("delegate_task requires safe command_id");
      if (!String(args.objective || "").trim()) throw new Error("delegate_task requires objective");
      if (!args.target && !args.agent) throw new Error("delegate_task requires target or agent");
      const scope = context.requestId ? `${context.requestId}:${id}` : id;
      const commandId = `delegate-${digest(scope)}`;
      const taskId = `delegated-${digest(scope)}`;
      const fingerprint = digest(stableStringify(args));
      const target = args.target ? resolveTarget(args.target) : "";
      if (args.target && !target) throw new Error("delegation target is not an active project worker");
      update((state) => {
        const existing = state.tasks[taskId];
        if (existing && existing.fingerprint !== fingerprint) throw Object.assign(new Error("delegation command conflicts"), { code: "command_conflict" });
        if (!existing) state.tasks[taskId] = { taskId, fingerprint, objective: args.objective,
          acceptanceCriteria: args.acceptance_criteria || [], parentTaskRunId: context.taskRunId || "",
          parentSessionId: context.sessionId || "", status: "planning", workerId: String(target), reportIds: [] };
      });
      let task = read().tasks[taskId];
      if (task.status !== "planning") return { ok: true, task: { ...task } };
      if (!task.workerId) {
        const nickname = args.nickname || `worker-${digest(scope).slice(0, 12)}`;
        const result = await commands.execute({ commandId: `${commandId}:launch`, kind: "launch_agent", args: { agent: args.agent, nickname } }, () => launch({ agent: args.agent, nickname, count: 1 }));
        if (!result || result.ok === false) return { ...result, ok: false, taskId };
        const rows = Array.isArray(result.ops_results) ? result.ops_results : [result];
        const workerId = rows.map((row) => row.agent_id || row.subscriber_ids?.[0] || "").find(Boolean);
        if (!workerId) return { ok: false, code: "awaiting_registration", taskId, error: "Launch receipt has no concrete worker identity; reconcile before dispatch." };
        update((state) => { state.tasks[taskId].workerId = workerId; });
        task = read().tasks[taskId];
      }
      const message = [args.objective, `Task ID: ${taskId}`, "Controller: ufoo-agent. Report start/progress/done/error with this exact task ID and private scope.",
        "Use ufoo report --task <id> --scope private --controller ufoo-agent, or MCP report_agent_status with task_id, scope=private, controller_id=ufoo-agent.",
        `Acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}`].join("\n\n");
      const receipt = await commands.execute({ commandId: `${commandId}:dispatch`, kind: "dispatch_message", args: { target: task.workerId, message } },
        () => dispatch({ target: task.workerId, message, taskId }));
      if (!receipt || receipt.ok === false) return { ...receipt, ok: false, taskId };
      update((state) => { const entry = state.tasks[taskId]; entry.status = "queued"; entry.dispatchReceipt = receipt; });
      emit({ type: "delegation.queued", taskId, workerId: task.workerId, parentTaskRunId: task.parentTaskRunId });
      return { ok: true, task: read().tasks[taskId], deliveryStatus: "queued" };
    },
    async report(entry) {
      const task = read().tasks[entry.task_id];
      if (!task || task.workerId !== entry.agent_id) return { matched: false };
      const reportId = entry.entry_id || digest(JSON.stringify(entry));
      if (task.reportIds.includes(reportId)) { await flushWakes(); return { matched: true, duplicate: true }; }
      update((state) => {
        const current = state.tasks[entry.task_id];
        current.reportIds.push(reportId);
        if (current.status === "accepted") return;
        if (current.report && ["done", "error"].includes(current.report.phase) && ["start", "progress"].includes(entry.phase)) return;
        current.report = entry;
        current.status = ["done", "error"].includes(entry.phase) ? "reported" : "running";
        if (current.status === "reported") current.pendingWake = `report-${digest(`${current.taskId}:${reportId}`)}`;
      });
      await flushWakes();
      return { matched: true, task: read().tasks[entry.task_id] };
    },
    accept({ task_id: taskId, outcome, reason, evidence = [] }, context = {}) {
      if (!["accepted", "rejected"].includes(outcome)) throw new Error("accept_task requires accepted or rejected outcome");
      update((state) => {
        const task = state.tasks[taskId];
        if (!task || task.status !== "reported") throw new Error("task has no unreviewed terminal report");
        if (outcome === "accepted" && (!String(reason || "").trim() || !evidence.length || task.report.phase !== "done")) throw new Error("acceptance requires a completed worker report, reason, and validation evidence");
        if (outcome === "accepted" && (!validateEvidence || validateEvidence(evidence, task, context) !== true)) throw new Error("host did not verify the acceptance evidence");
        task.status = outcome;
        task.acceptance = { outcome, reason, evidence };
      });
      return { ok: true, task: read().tasks[taskId] };
    },
  });
}

module.exports = { createAgentManagementService };
