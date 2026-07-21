"use strict";

/**
 * Native ucode slash-command registry (shared by REPL help + TUI completions).
 */

const UCODE_COMMAND_REGISTRY = [
  { cmd: "/help", desc: "Show available commands", order: 10 },
  { cmd: "/status", desc: "Show session / usage status", order: 20 },
  { cmd: "/model", desc: "Show or switch the active model", order: 25 },
  { cmd: "/ubus", desc: "Check pending bus messages", order: 30 },
  { cmd: "/resume", desc: "Resume a saved session", order: 40 },
  { cmd: "/skills", desc: "List or show skills", order: 50 },
  { cmd: "/bg", desc: "Run a task in the background", order: 60 },
  { cmd: "/exit", desc: "Exit ucode", order: 90 },
];

const UCODE_COMMAND_TREE = {
  "/help": { desc: "Show available commands" },
  "/status": { desc: "Show session / usage status" },
  "/model": {
    desc: "Show or switch the active model",
    hasArguments: true,
    optionalArguments: true,
  },
  "/ubus": { desc: "Check pending bus messages" },
  "/resume": { desc: "Resume a saved session", hasArguments: true },
  "/skills": {
    desc: "List or show skills",
    children: {
      list: { desc: "List available skills", order: 1 },
      show: { desc: "Show a skill by name", order: 2, hasArguments: true },
    },
  },
  "/bg": { desc: "Run a task in the background", hasArguments: true },
  "/exit": { desc: "Exit ucode" },
  "/quit": { desc: "Exit ucode" },
};

function listUcodeCommandsForHelp() {
  return [
    "Commands:",
    "  /help",
    "  /exit|/quit",
    "  /ubus",
    "  /status",
    "  /model [model-id]",
    "  /skills [list]",
    "  /skills show <name>",
    "  /bg <task>",
    "  /resume <session-id>",
    "  tool <read|write|edit|bash> <args-json>",
    "  run <read|write|edit|bash> <args-json>",
  ].join("\n");
}

module.exports = {
  UCODE_COMMAND_REGISTRY,
  UCODE_COMMAND_TREE,
  listUcodeCommandsForHelp,
};
