"use strict";

const IPC_REQUEST_TYPES = {
  STATUS: "status",
  PROMPT: "prompt",
  CRON: "cron",
  BUS_SEND: "bus_send",
  BUS_WATCH: "bus_watch",
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
  ASSIGN_ROLE: "assign_role",
  REFRESH_STATUS: "refresh_status",
  CONTROL_PLANE_CALL: "control_plane_call",
  CONTROL_PLANE_CANCEL: "control_plane_cancel",
  MCP_STATUS: "mcp_status",
  MCP_RESTART: "mcp_restart",
};

const IPC_RESPONSE_TYPES = {
  STATUS: "status",
  RESPONSE: "response",
  BUS: "bus",
  ERROR: "error",
  BUS_SEND_OK: "bus_send_ok",
  REGISTER_OK: "register_ok",
  CONTROL_PLANE_RESULT: "control_plane_result",
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
