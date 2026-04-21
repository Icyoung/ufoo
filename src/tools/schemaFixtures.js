const SCHEMA_VERSION = "1.0";

const CALLER_TIERS_READ_COORD = Object.freeze(["controller", "worker"]);
const CALLER_TIERS_CONTROLLER_ONLY = Object.freeze(["controller"]);

const READ_BUS_SUMMARY_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "read_bus_summary",
  tier: "tier0-read",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "Read the current project bus, unread, decisions, report, cron, and group summary.",
  input_schema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["project_root", "summary"],
    properties: Object.freeze({
      project_root: Object.freeze({ type: "string" }),
      summary: Object.freeze({
        type: "object",
        required: ["active_count", "busy_count", "ready_count", "unread_total", "decisions_open"],
        properties: Object.freeze({
          active_count: Object.freeze({ type: "integer" }),
          busy_count: Object.freeze({ type: "integer" }),
          ready_count: Object.freeze({ type: "integer" }),
          unread_total: Object.freeze({ type: "integer" }),
          decisions_open: Object.freeze({ type: "integer" }),
          reports_pending_total: Object.freeze({ type: "integer" }),
          controller_pending_total: Object.freeze({ type: "integer" }),
          cron_count: Object.freeze({ type: "integer" }),
          groups_active: Object.freeze({ type: "integer" }),
        }),
        additionalProperties: false,
      }),
      active_agents: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const READ_PROMPT_HISTORY_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "read_prompt_history",
  tier: "tier0-read",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "Read recent prompt-history summaries for active agents from bus events.",
  input_schema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      target: Object.freeze({ type: "string" }),
      per_agent_limit: Object.freeze({ type: "integer", minimum: 1 }),
      max_files: Object.freeze({ type: "integer", minimum: 1 }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["scanned_files", "matched_events", "per_agent"],
    properties: Object.freeze({
      scanned_files: Object.freeze({ type: "integer" }),
      matched_events: Object.freeze({ type: "integer" }),
      per_agent: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const READ_OPEN_DECISIONS_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "read_open_decisions",
  tier: "tier0-read",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "List open decisions for the current project.",
  input_schema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      limit: Object.freeze({ type: "integer", minimum: 1 }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["count", "decisions"],
    properties: Object.freeze({
      count: Object.freeze({ type: "integer" }),
      decisions: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const LIST_AGENTS_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "list_agents",
  tier: "tier0-read",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "List active agents with nickname, status, and activity metadata.",
  input_schema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["count", "agents"],
    properties: Object.freeze({
      count: Object.freeze({ type: "integer" }),
      agents: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const READ_PROJECT_REGISTRY_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "read_project_registry",
  tier: "tier0-read",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "Read the cross-project runtime registry.",
  input_schema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      validate: Object.freeze({ type: "boolean" }),
      cleanup_tmp: Object.freeze({ type: "boolean" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["count", "projects"],
    properties: Object.freeze({
      count: Object.freeze({ type: "integer" }),
      projects: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const ROUTE_AGENT_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "route_agent",
  tier: "tier1-coordination",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "Pick the best agent or nickname for the user request.",
  input_schema: Object.freeze({
    type: "object",
    required: ["request"],
    properties: Object.freeze({
      request: Object.freeze({ type: "string" }),
      context_hint: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["target"],
    properties: Object.freeze({
      target: Object.freeze({ type: "string" }),
      nickname: Object.freeze({ type: "string" }),
      reason: Object.freeze({ type: "string" }),
      confidence: Object.freeze({ type: "number" }),
    }),
    additionalProperties: false,
  }),
});

const DISPATCH_MESSAGE_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "dispatch_message",
  tier: "tier1-coordination",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "Send a message to a target agent, nickname, or broadcast queue.",
  input_schema: Object.freeze({
    type: "object",
    required: ["target", "message"],
    properties: Object.freeze({
      target: Object.freeze({ type: "string" }),
      message: Object.freeze({ type: "string" }),
      mode: Object.freeze({
        type: "string",
        enum: Object.freeze(["immediate", "queued"]),
      }),
      source: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["ok"],
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      delivered: Object.freeze({ type: "integer" }),
      queued: Object.freeze({ type: "integer" }),
      targets: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    additionalProperties: false,
  }),
});

const ACK_BUS_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "ack_bus",
  tier: "tier1-coordination",
  allowed_tiers: CALLER_TIERS_READ_COORD,
  description: "Acknowledge pending bus messages for the caller-owned queue only.",
  input_schema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      subscriber: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["ok", "subscriber", "acknowledged"],
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      subscriber: Object.freeze({ type: "string" }),
      acknowledged: Object.freeze({ type: "integer" }),
    }),
    additionalProperties: false,
  }),
});

const LAUNCH_AGENT_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "launch_agent",
  tier: "tier2-orchestration",
  allowed_tiers: CALLER_TIERS_CONTROLLER_ONLY,
  description: "Launch one or more worker agents for controller orchestration.",
  input_schema: Object.freeze({
    type: "object",
    required: ["agent"],
    properties: Object.freeze({
      agent: Object.freeze({
        type: "string",
        enum: Object.freeze(["codex", "claude", "ucode"]),
      }),
      count: Object.freeze({ type: "integer", minimum: 1 }),
      nickname: Object.freeze({ type: "string" }),
      prompt_profile: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["ok"],
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      launched: Object.freeze({ type: "integer" }),
      agent_ids: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    additionalProperties: false,
  }),
});

const RENAME_AGENT_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "rename_agent",
  tier: "tier2-orchestration",
  allowed_tiers: CALLER_TIERS_CONTROLLER_ONLY,
  description: "Rename an existing agent session.",
  input_schema: Object.freeze({
    type: "object",
    required: ["agent_id", "nickname"],
    properties: Object.freeze({
      agent_id: Object.freeze({ type: "string" }),
      nickname: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["ok"],
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      operation: Object.freeze({ type: "object", additionalProperties: true }),
      ops_results: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const CLOSE_AGENT_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "close_agent",
  tier: "tier2-orchestration",
  allowed_tiers: CALLER_TIERS_CONTROLLER_ONLY,
  description: "Close an existing agent session.",
  input_schema: Object.freeze({
    type: "object",
    required: ["agent_id"],
    properties: Object.freeze({
      agent_id: Object.freeze({ type: "string" }),
      target: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["ok"],
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      operation: Object.freeze({ type: "object", additionalProperties: true }),
      ops_results: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const MANAGE_CRON_SCHEMA = Object.freeze({
  schema_version: SCHEMA_VERSION,
  name: "manage_cron",
  tier: "tier2-orchestration",
  allowed_tiers: CALLER_TIERS_CONTROLLER_ONLY,
  description: "Create, list, or stop controller cron tasks.",
  input_schema: Object.freeze({
    type: "object",
    required: ["operation"],
    properties: Object.freeze({
      operation: Object.freeze({
        type: "string",
        enum: Object.freeze(["start", "list", "stop"]),
      }),
      id: Object.freeze({ type: "string" }),
      every: Object.freeze({ type: "string" }),
      interval_ms: Object.freeze({ type: "integer" }),
      at: Object.freeze({ type: "string" }),
      once_at_ms: Object.freeze({ type: "integer" }),
      target: Object.freeze({ type: "string" }),
      targets: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
      prompt: Object.freeze({ type: "string" }),
      title: Object.freeze({ type: "string" }),
    }),
    additionalProperties: false,
  }),
  output_schema: Object.freeze({
    type: "object",
    required: ["ok"],
    properties: Object.freeze({
      ok: Object.freeze({ type: "boolean" }),
      operation: Object.freeze({ type: "object", additionalProperties: true }),
      ops_results: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    }),
    additionalProperties: false,
  }),
});

const PHASE0_TOOL_SCHEMAS = Object.freeze({
  read_bus_summary: READ_BUS_SUMMARY_SCHEMA,
  read_prompt_history: READ_PROMPT_HISTORY_SCHEMA,
  read_open_decisions: READ_OPEN_DECISIONS_SCHEMA,
  list_agents: LIST_AGENTS_SCHEMA,
  read_project_registry: READ_PROJECT_REGISTRY_SCHEMA,
  route_agent: ROUTE_AGENT_SCHEMA,
  dispatch_message: DISPATCH_MESSAGE_SCHEMA,
  ack_bus: ACK_BUS_SCHEMA,
  launch_agent: LAUNCH_AGENT_SCHEMA,
  rename_agent: RENAME_AGENT_SCHEMA,
  close_agent: CLOSE_AGENT_SCHEMA,
  manage_cron: MANAGE_CRON_SCHEMA,
});

module.exports = {
  SCHEMA_VERSION,
  READ_BUS_SUMMARY_SCHEMA,
  READ_PROMPT_HISTORY_SCHEMA,
  READ_OPEN_DECISIONS_SCHEMA,
  LIST_AGENTS_SCHEMA,
  READ_PROJECT_REGISTRY_SCHEMA,
  ROUTE_AGENT_SCHEMA,
  DISPATCH_MESSAGE_SCHEMA,
  ACK_BUS_SCHEMA,
  LAUNCH_AGENT_SCHEMA,
  RENAME_AGENT_SCHEMA,
  CLOSE_AGENT_SCHEMA,
  MANAGE_CRON_SCHEMA,
  PHASE0_TOOL_SCHEMAS,
};
