"use strict";

const IPC_REQUEST_TYPES = {
  STATUS: "status",
  PROMPT: "prompt",
  CRON: "cron",
  BUS_SEND: "bus_send",
  CLOSE_AGENT: "close_agent",
  LAUNCH_AGENT: "launch_agent",
  LAUNCH_GROUP: "launch_group",
  RESUME_AGENTS: "resume_agents",
  LIST_RECOVERABLE_AGENTS: "list_recoverable_agents",
  STOP_GROUP: "stop_group",
  GROUP_STATUS: "group_status",
  GROUP_TEMPLATE_VALIDATE: "group_template_validate",
  GROUP_DIAGRAM: "group_diagram",
  REGISTER_AGENT: "register_agent",
  AGENT_READY: "agent_ready",
  AGENT_REPORT: "agent_report",
};

const IPC_RESPONSE_TYPES = {
  STATUS: "status",
  RESPONSE: "response",
  BUS: "bus",
  ERROR: "error",
  BUS_SEND_OK: "bus_send_ok",
  REGISTER_OK: "register_ok",
};

const BUS_STATUS_PHASES = {
  START: "start",
  DONE: "done",
  ERROR: "error",
};

module.exports = {
  IPC_REQUEST_TYPES,
  IPC_RESPONSE_TYPES,
  BUS_STATUS_PHASES,
};
