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
            command: { type: "string" },
            timeoutMs: { type: "integer" },
          },
          required: ["command"],
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
              description: "Full graph for create (objective + nodes). group is input sugar only.",
            },
            operations: {
              type: "array",
              description: [
                "Patch ops only: add_node, expand_node, add_dependency, remove_dependency.",
                "Status actions (complete_task, skip_node, cancel_subtree) belong under control.actions.",
              ].join(" "),
              items: { type: "object" },
            },
            actions: {
              type: "array",
              description: [
                "Control actions: start_task, cancel_task, fail_task, complete_task, skip_node, cancel_subtree.",
                "complete_task with taskRunId finishes a TaskLoop TaskRun;",
                "complete_task with nodeId finishes a waiting_llm inline task owned by the graph owner.",
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
