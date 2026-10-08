"use strict";

const string = { type: "string", minLength: 1 };
const command = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$" };
const strings = { type: "array", items: string, maxItems: 100 };
const schema = (name, description, required, properties) => Object.freeze({ name, description, schema_version: "1.0",
  allowed_tiers: ["controller"], input_schema: { type: "object", required, properties, additionalProperties: false },
  output_schema: { type: "object" } });
const CONTROLLER_TOOL_SCHEMAS = Object.freeze({
  delegate_task: schema("delegate_task", "Delegate to a concrete worker, or durably launch and bind one first. Reuse command_id on retries. Returns queue persistence, not completion.",
    ["command_id", "objective"], { command_id: command, objective: string, target: string, agent: { type: "string", enum: ["codex", "claude", "ucode", "grok", "kimi", "agy"] }, nickname: string, acceptance_criteria: strings }),
  read_task_reports: schema("read_task_reports", "Read delegated task ownership, delivery and report status. A terminal report still requires validation and acceptance.", [], { task_id: string }),
  accept_task: schema("accept_task", "Accept or reject an unreviewed terminal worker report. Acceptance requires validation evidence and a reason; ordinary replies do not complete tasks.",
    ["task_id", "outcome", "reason"], { task_id: string, outcome: { type: "string", enum: ["accepted", "rejected"] }, reason: string, evidence: strings }),
  manage_tasks: schema("manage_tasks", "Start independent coding task contexts without blocking the main conversation; inspect or cancel their durable runs. Reuse command_id on start retries.",
    ["operation"], { operation: { type: "string", enum: ["start", "inspect", "cancel", "list", "accept", "reject"] }, command_id: command, objective: string, task_run_id: string, reason: string, evidence: strings,
      workspace: string, read_only: { type: "boolean" } }),
  resume_agents: schema("resume_agents", "Inspect recoverable worker sessions or resume a selected worker through the project host.",
    ["operation"], { operation: { type: "string", enum: ["inspect", "resume"] }, target: string, command_id: command }),
  manage_group: schema("manage_group", "Validate, start, stop or inspect project groups through the daemon group service. Use command_id for mutations.",
    ["operation"], { operation: { type: "string", enum: ["validate", "start", "stop", "status"] }, command_id: command, target: string, group_id: string }),
});

module.exports = { CONTROLLER_TOOL_SCHEMAS };
