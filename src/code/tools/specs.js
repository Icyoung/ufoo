"use strict";

const { getReadToolDescription } = require("../../agents/prompts/native/toolDescriptions/read");
const { getReadImageToolDescription } = require("../../agents/prompts/native/toolDescriptions/readImage");
const { getWriteToolDescription } = require("../../agents/prompts/native/toolDescriptions/write");
const { getEditToolDescription } = require("../../agents/prompts/native/toolDescriptions/edit");
const { getBashToolDescription } = require("../../agents/prompts/native/toolDescriptions/bash");

function buildCoreToolSpecs() {
  return [
    {
      type: "function",
      function: {
        name: "read",
        description: getReadToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            maxBytes: { type: "integer" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_image",
        description: getReadImageToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path to a png, jpeg, gif, or webp image.",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: getWriteToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: {
              type: "string",
              enum: ["overwrite", "append"],
              description: 'Write mode: "overwrite" replaces the file (default), "append" adds to its end.',
            },
            append: { type: "boolean" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: getEditToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            find: { type: "string" },
            replace: { type: "string" },
            all: { type: "boolean" },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: getBashToolDescription(),
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Shell command to execute when action is \"run\" (default).",
            },
            timeoutMs: {
              type: "integer",
              description: "Foreground command timeout in milliseconds (default 60000, max 600000).",
            },
            background: {
              type: "boolean",
              description: "Set true to start a long-running background process (dev server, watcher) detached from the foreground turn.",
            },
            startupWaitMs: {
              type: "integer",
              description: "When background=true, milliseconds to wait for initial startup logs or early exit (default 2500, max 15000).",
            },
            wake: {
              type: "object",
              description: "Background runtime notifications. Exit notification defaults to true on supported native hosts. Each condition fires once, without model polling. Only valid when starting a background command.",
              additionalProperties: false,
              properties: {
                onExit: { type: "boolean", description: "Notify once on command exit (default true)." },
                timeoutMs: { type: "integer", minimum: 100, maximum: 43200000, description: "Subscription lifetime; default 12 hours. Expiry notifies once without killing the process." },
                conditions: { type: "array", maxItems: 8, items: {
                  type: "object", additionalProperties: false, required: ["type"],
                  properties: {
                    type: { type: "string", enum: ["log_contains", "file_exists", "port_open"] },
                    text: { type: "string", description: "Literal log substring for log_contains; at most 1024 bytes." },
                    path: { type: "string", description: "Workspace path for file_exists." },
                    port: { type: "integer", minimum: 1, maximum: 65535, description: "Local IPv4 loopback port for port_open." },
                  },
                } },
              },
            },
            action: {
              type: "string",
              enum: ["run", "logs", "status", "list", "stop"],
              description: "Operation mode: \"run\" (default) executes command; \"logs\" reads background output; \"status\" checks process state; \"list\" lists background processes; \"stop\" terminates a background process.",
            },
            backgroundId: {
              type: "string",
              description: "Background process ID returned when starting with background=true. Required for logs, status, and stop.",
            },
            offset: {
              type: "integer",
              description: "Byte offset for incremental log reads with action=\"logs\" (pass previous nextOffset to read only newly appended output).",
            },
            tailLines: {
              type: "integer",
              description: "Number of recent log lines to return when offset is omitted (default 80, max 500).",
            },
            maxBytes: {
              type: "integer",
              description: "Maximum log bytes to read in one call (default 32768, max 200000).",
            },
            waitMs: {
              type: "integer",
              description: "Optional milliseconds to wait for new log output when action=\"logs\" and process is running (default 0, max 10000).",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "artifact_read",
        description: [
          "Read previously stored tool output by artifactId.",
          "This does not read workspace files; use `read` for repository paths.",
          "Optionally read a slice with startLine/endLine, maxChars, or tailLines.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            artifactId: { type: "string" },
            sessionId: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            maxChars: { type: "integer" },
            tailLines: { type: "integer" },
          },
          required: ["artifactId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "plan_graph",
        description: [
          "Manage the persistent Plan Graph and graph-bound TaskRuns.",
          "TaskRuns are orthogonal to Plan Mode; for a standalone TaskRun without a plan, use `task_run` instead.",
          "Use create, patch, inspect, or cancel_graph for graph operations, and control for graph-bound TaskRun lifecycle.",
          "`control.start_task` starts a graph `task_loop` asynchronously and returns immediately.",
          "Use `inline_llm` for work handled by the current graph owner,",
          "`expand` for tasks that must be lowered into child nodes,",
          "and `task_loop` for asynchronous work in an independent TaskLoop attached to a plan node.",
          "Do not call `plan_graph` together with data-plane tools in the same assistant turn.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: [
                "create",
                "patch",
                "inspect",
                "clear",
                "cancel_graph",
                "control",
              ],
              description: [
                "create/patch/inspect/cancel_graph mutate or inspect the graph spec;",
                "control runs TaskRun lifecycle and node status actions.",
              ].join(" "),
            },
            graph: {
              type: "object",
              description: [
                'Full graph for create (objective + nodes).',
                'Task nodes use {id,type:"task",title:"<concise UI heading, ~4-12 words>",content:"<detailed instructions/criteria>",dependsOn?,execution?};',
                'always keep `title` short for the plan card UI and put detailed instructions in `content` (or `objective`).',
                'Tool nodes use {id,type:"tool",tool,args:{...}}; tool parameters belong in args. group is input sugar only.',
              ].join(" "),
            },
            operations: {
              type: "array",
              description: [
                "Dynamic plan spec operations: add_node (append a step; supports optional after/before/parentTaskId),",
                "update_node (modify title/content/args/dependsOn on non-running/non-succeeded nodes),",
                "remove_node (delete an obsolete non-running/non-succeeded node),",
                "expand_node (expand a task or append children to an aggregate task),",
                "add_dependency, remove_dependency, update_plan (update objective).",
                "Status actions (complete_task, retry_node, skip_node, fail_node, cancel_subtree) belong under control.actions.",
                'Tool children use {id,type:"tool",tool:"read",args:{path:"AGENTS.md"}}. Use args, not arguments.',
              ].join(" "),
              items: { type: "object" },
            },
            actions: {
              type: "array",
              description: [
                "Control actions: start_task, cancel_task, fail_task, complete_task, retry_node, skip_node, fail_node, cancel_subtree.",
                "complete_task with taskRunId finishes a TaskLoop TaskRun;",
                "complete_task with nodeId finishes a waiting_llm inline task owned by the graph owner.",
                "retry_node resets a failed/blocked node (with optional updated args) and unblocks dependents;",
                "skip_node skips a pending/failed/blocked node and unblocks dependents;",
                "fail_node explicitly marks a task failed when moving on.",
              ].join(" "),
              items: { type: "object" },
            },
            reason: {
              type: "string",
              description: "Optional reason for cancel_graph or fail/cancel task.",
            },
            commandId: {
              type: "string",
              description: [
                "Optional idempotency key for explicit replay.",
                "When omitted, the Runtime should derive one from the tool invocation when available.",
              ].join(" "),
            },
            expectedSpecRevision: {
              type: "integer",
              description: "Optional optimistic concurrency token for patch.",
            },
            graphId: {
              type: "string",
              description: "Optional graph id check for patch/control.",
            },
          },
          required: ["operation"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "task_run",
        description: [
          "Start, inspect, cancel, fail, or complete a TaskRun.",
          "TaskRuns are orthogonal to Plan Mode and do not require a plan_graph.",
          "Use operation=start with an objective for a standalone single-point TaskRun; it returns immediately.",
          "On complex multi-goal work, decompose into concrete objectives and start one or more TaskRuns.",
          "Use plan_graph control.start_task only when the TaskRun is attached to a plan_graph task_loop node.",
          "Do not call `task_run` together with data-plane tools in the same assistant turn.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["start", "cancel", "fail", "complete", "inspect"],
              description: [
                "start creates a standalone TaskRun from objective;",
                "cancel/fail/complete/inspect address an existing taskRunId",
                "(cancel/fail may also use nodeId for graph-bound runs).",
              ].join(" "),
            },
            objective: {
              type: "string",
              description: "Required for start: concrete TaskRun objective.",
            },
            title: {
              type: "string",
              description: "Optional short title for start.",
            },
            taskRunId: {
              type: "string",
              description: "TaskRun id for cancel, fail, complete, or inspect.",
            },
            nodeId: {
              type: "string",
              description: "Optional graph node id for cancel/fail of a graph-bound TaskRun.",
            },
            reason: {
              type: "string",
              description: "Optional reason for cancel or fail.",
            },
            result: {
              type: "object",
              description: "Optional result payload for complete (TaskLoop owner).",
            },
            commandId: {
              type: "string",
              description: "Optional idempotency key for explicit replay.",
            },
          },
          required: ["operation"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ask_user",
        description: [
          "Ask the user for input and pause the current Agent loop until the reply arrives.",
          "Use only when user input is required to proceed, not for routine updates or decisions the agent can safely make.",
          "`kind=approval` requests yes/no confirmation; `kind=choice` presents the supplied options; `kind=chat` requests free text.",
          "This must be the only tool call in the turn.",
          "The reply is returned only as this tool result, not as a separate user message or pending user prompt.",
          "After the tool returns, continue from the answer and do not ask the same question again.",
          "Running TaskRuns are not paused automatically.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["approval", "choice", "chat"],
              description: "Interaction type.",
            },
            prompt: {
              type: "string",
              description: "Question shown to the user.",
            },
            options: {
              type: "array",
              description: "For choice: option labels (or {key,label} objects). Ignored for chat.",
              items: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      label: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
          required: ["kind", "prompt"],
        },
      },
    },
  ];
}

function buildAnthropicToolSpecs() {
  return buildCoreToolSpecs().map((spec) => ({
    name: spec.function.name,
    description: spec.function.description,
    input_schema: spec.function.parameters,
  }));
}

module.exports = { buildCoreToolSpecs, buildAnthropicToolSpecs };
