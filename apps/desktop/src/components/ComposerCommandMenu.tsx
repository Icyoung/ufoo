import React, { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowsClockwise,
  BookOpen,
  Broadcast,
  CaretRight,
  ChatCircleDots,
  Clock,
  ClockCounterClockwise,
  Columns,
  Cpu,
  Eraser,
  FlowArrow,
  FolderOpen,
  GearSix,
  ListChecks,
  PlugsConnected,
  Pulse,
  RocketLaunch,
  SlidersHorizontal,
  Sparkle,
  Terminal,
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react";
import type { CompletionItem, WorkerSummary } from "../types";
import { BrandIcon } from "./BrandIcon";
import { DotGridLoader } from "./DotGridLoader";

export type CommandCategory = "Agents & Workflows" | "Session & View" | "Workspace & Tools";
export type MenuActionKind = "drill" | "execute" | "fill" | "mention";

type IconKey =
  | "rocket"
  | "group"
  | "user"
  | "resume"
  | "role"
  | "bus"
  | "chat"
  | "eraser"
  | "layout"
  | "model"
  | "provider"
  | "context"
  | "clock"
  | "tasks"
  | "skills"
  | "pulse"
  | "doctor"
  | "settings"
  | "mcp"
  | "daemon"
  | "folder"
  | "terminal"
  | "flow";

interface SubcommandDef {
  key: string;
  title: string;
  description: string;
  action: "drill" | "execute" | "fill";
  argsHint?: string;
  brand?: string;
  icon?: IconKey;
  dynamic?: boolean;
  children?: SubcommandDef[];
}

interface CommandDef {
  cmd: string;
  title: string;
  description: string;
  category: CommandCategory;
  icon: IconKey;
  action: "drill" | "execute" | "fill";
  argsHint?: string;
  keywords: string[];
  dynamic?: boolean;
  hiddenByDefault?: boolean;
  children?: SubcommandDef[];
}

export interface ComposerMenuItem {
  id: string;
  title: string;
  description: string;
  command: string;
  replace: string;
  category?: CommandCategory;
  action: MenuActionKind;
  argsHint?: string;
  icon?: IconKey;
  brand?: string;
  brandColor?: string;
  metaBadge?: string;
  statusDot?: "working" | "ready";
}

export interface BreadcrumbSegment {
  label: string;
  targetInput: string;
}

export interface ArgHintInfo {
  title: string;
  command: string;
  argsHint: string;
  description: string;
}

export interface ComposerMenuState {
  mode: "none" | "commands" | "mentions" | "arg_hint";
  breadcrumb: BreadcrumbSegment[];
  items: ComposerMenuItem[];
  argHint?: ArgHintInfo;
  needsDynamicFetch: boolean;
  dynamicEmptyText?: string;
  mentionRange?: { start: number; end: number };
}

const THINKING_LABELS: Record<string, { title: string; desc: string }> = {
  none: { title: "None", desc: "Direct response without extended reasoning" },
  minimal: { title: "Minimal", desc: "Fastest response with light reasoning" },
  low: { title: "Low", desc: "Quick reasoning for straightforward tasks" },
  medium: { title: "Medium", desc: "Balanced reasoning speed and depth" },
  high: { title: "High", desc: "Deep multi-step reasoning for hard problems" },
  xhigh: { title: "Extra High", desc: "Maximum reasoning depth for complex engineering" },
};

const COMMAND_DEFS: CommandDef[] = [
  // ── Agents & Workflows ─────────────────────────────────────────────
  {
    cmd: "/launch",
    title: "Launch Worker Agent",
    description: "Start a new ucode, Codex, Claude, or Antigravity worker in this project",
    category: "Agents & Workflows",
    icon: "rocket",
    action: "drill",
    keywords: ["worker", "start", "new", "agent", "spawn", "claude", "codex", "ucode", "agy", "antigravity"],
    children: [
      {
        key: "ucode",
        title: "ucode",
        description: "Launch a native ucode coding agent",
        action: "execute",
        brand: "ucode",
      },
      {
        key: "codex",
        title: "Codex",
        description: "Launch an internal Codex worker agent",
        action: "execute",
        brand: "codex",
      },
      {
        key: "claude",
        title: "Claude Code",
        description: "Launch an internal Claude Code worker agent",
        action: "execute",
        brand: "claude",
      },
      {
        key: "agy",
        title: "Antigravity",
        description: "Launch an internal Antigravity (agy) worker agent",
        action: "execute",
        brand: "agy",
      },
    ],
  },
  {
    cmd: "/group",
    title: "Agent Groups",
    description: "Run, inspect, or stop multi-agent workflow groups",
    category: "Agents & Workflows",
    icon: "group",
    action: "drill",
    keywords: ["team", "workflow", "template", "multi", "orchestrate"],
    children: [
      {
        key: "run",
        title: "Run Group Template",
        description: "Pick a workflow template to launch a coordinated group",
        action: "drill",
        icon: "flow",
        dynamic: true,
      },
      {
        key: "status",
        title: "Group Status",
        description: "Inspect active group members and runtime state",
        action: "execute",
        icon: "pulse",
      },
      {
        key: "stop",
        title: "Stop Group",
        description: "Shut down a currently running group",
        action: "execute",
        icon: "group",
      },
      {
        key: "diagram",
        title: "Workflow Diagram",
        description: "Render the topology diagram for the active group",
        action: "execute",
        icon: "flow",
      },
      {
        key: "templates",
        title: "List Templates",
        description: "Show all available group workflow templates",
        action: "execute",
        icon: "skills",
      },
      {
        key: "template",
        title: "Manage Templates",
        description: "Inspect, validate, or scaffold a group template",
        action: "fill",
        argsHint: "<list | show | validate | new>",
        icon: "settings",
      },
    ],
  },
  {
    cmd: "/solo",
    title: "Solo Role Agent",
    description: "Launch a single worker with a specialized role preset",
    category: "Agents & Workflows",
    icon: "user",
    action: "drill",
    keywords: ["role", "preset", "profile", "specialist"],
    children: [
      {
        key: "run",
        title: "Launch Solo Role",
        description: "Choose a specialized role profile to start",
        action: "drill",
        icon: "rocket",
        dynamic: true,
      },
      {
        key: "list",
        title: "List Solo Roles",
        description: "Show all available solo role profiles",
        action: "execute",
        icon: "skills",
      },
    ],
  },
  {
    cmd: "/resume",
    title: "Resume Session",
    description: "Restore a previous internal worker session or group",
    category: "Agents & Workflows",
    icon: "resume",
    action: "drill",
    dynamic: true,
    keywords: ["restore", "continue", "recover", "history", "previous"],
  },
  {
    cmd: "/role",
    title: "Assign Role",
    description: "Apply a prompt profile to an existing active worker",
    category: "Agents & Workflows",
    icon: "role",
    action: "drill",
    keywords: ["profile", "prompt", "persona"],
    children: [
      {
        key: "assign",
        title: "Assign Role to Agent",
        description: "Apply a role profile to a running agent",
        action: "fill",
        argsHint: "<agent> <role>",
        icon: "role",
      },
      {
        key: "list",
        title: "List Role Profiles",
        description: "Show available prompt profiles",
        action: "execute",
        icon: "skills",
      },
    ],
  },
  {
    cmd: "/bus",
    title: "Agent Bus",
    description: "Send messages, list, or rename connected agents",
    category: "Agents & Workflows",
    icon: "bus",
    action: "drill",
    keywords: ["message", "send", "agents", "rename", "relay"],
    children: [
      {
        key: "list",
        title: "List Connected Agents",
        description: "Show all active internal and MCP agents",
        action: "execute",
        icon: "bus",
      },
      {
        key: "status",
        title: "Bus Status",
        description: "Check local event bus delivery and queue health",
        action: "execute",
        icon: "pulse",
      },
      {
        key: "send",
        title: "Send Message to Agent",
        description: "Deliver a direct message to another agent over the bus",
        action: "fill",
        argsHint: "<agent> <message>",
        icon: "chat",
      },
      {
        key: "rename",
        title: "Rename Agent",
        description: "Change an agent's display nickname",
        action: "fill",
        argsHint: "<agent> <new-name>",
        icon: "user",
      },
      {
        key: "activate",
        title: "Focus Agent Terminal",
        description: "Bring an external agent terminal window forward",
        action: "fill",
        argsHint: "<agent>",
        icon: "terminal",
      },
    ],
  },

  // ── Session & View ─────────────────────────────────────────────────
  {
    cmd: "/session",
    title: "Conversation",
    description: "Start a fresh conversation or inspect session info",
    category: "Session & View",
    icon: "chat",
    action: "drill",
    keywords: ["new", "reset", "chat", "id", "conversation"],
    children: [
      {
        key: "new",
        title: "New Conversation",
        description: "Start a clean ufoo conversation with current settings",
        action: "execute",
        icon: "chat",
      },
      {
        key: "show",
        title: "Show Session Info",
        description: "Display the active conversation ID",
        action: "execute",
        icon: "pulse",
      },
    ],
  },
  {
    cmd: "/clear",
    title: "Clear Conversation",
    description: "Clear messages from the current chat view",
    category: "Session & View",
    icon: "eraser",
    action: "execute",
    keywords: ["clean", "wipe", "empty", "reset"],
  },
  {
    cmd: "/window",
    title: "Switch Layout",
    description: "Change between Main, Side, and Multi workflow views",
    category: "Session & View",
    icon: "layout",
    action: "drill",
    keywords: ["view", "mode", "split", "multi", "side", "main", "canvas"],
    children: [
      {
        key: "main",
        title: "Main Chat View",
        description: "Focus solely on the main conversation",
        action: "execute",
        icon: "layout",
      },
      {
        key: "side",
        title: "Side-by-Side View",
        description: "Main chat alongside one active worker",
        action: "execute",
        icon: "layout",
      },
      {
        key: "multi",
        title: "Agent Group Canvas",
        description: "Visual node canvas for coordinating multiple workers",
        action: "execute",
        icon: "flow",
      },
    ],
  },
  {
    cmd: "/model",
    title: "Model & Effort",
    description: "Switch active model and thinking intensity for ufoo",
    category: "Session & View",
    icon: "model",
    action: "drill",
    dynamic: true,
    keywords: ["llm", "thinking", "effort", "gpt", "claude", "ai"],
  },
  {
    cmd: "/provider",
    title: "Main Provider",
    description: "Switch the AI provider powering the ufoo main agent",
    category: "Session & View",
    icon: "provider",
    action: "drill",
    keywords: ["backend", "codex", "claude", "agy", "kimi", "openai", "custom"],
    children: [
      {
        key: "show",
        title: "Show Current Provider",
        description: "Display the active provider and model",
        action: "execute",
        icon: "pulse",
      },
      {
        key: "codex",
        title: "Codex",
        description: "Use Codex for the ufoo main agent",
        action: "execute",
        brand: "codex",
      },
      {
        key: "claude",
        title: "Claude",
        description: "Use Claude for the ufoo main agent",
        action: "execute",
        brand: "claude",
      },
      {
        key: "agy",
        title: "Antigravity (agy)",
        description: "Use Antigravity for the ufoo main agent",
        action: "execute",
        brand: "agy",
      },
      {
        key: "kimi",
        title: "Kimi Code",
        description: "Use Kimi Code for the ufoo main agent",
        action: "execute",
        brand: "kimi",
      },
      {
        key: "custom",
        title: "Custom OpenAI Endpoint",
        description: "Configure a custom base URL and API key",
        action: "fill",
        argsHint: "url=<api-url> key=<api-key>",
        icon: "settings",
      },
    ],
  },

  // ── Workspace & Tools ──────────────────────────────────────────────
  {
    cmd: "/ctx",
    title: "Context & Decisions",
    description: "Review architectural decisions and shared context health",
    category: "Workspace & Tools",
    icon: "context",
    action: "drill",
    keywords: ["memory", "decision", "context", "adr", "docs"],
    children: [
      {
        key: "status",
        title: "Context Overview",
        description: "Show shared decisions and durable memory status",
        action: "execute",
        icon: "context",
      },
      {
        key: "decisions",
        title: "List Decisions",
        description: "View open and recorded architectural decisions",
        action: "execute",
        icon: "tasks",
      },
      {
        key: "doctor",
        title: "Context Health Check",
        description: "Verify shared context files and index integrity",
        action: "execute",
        icon: "doctor",
      },
    ],
  },
  {
    cmd: "/cron",
    title: "Scheduled Tasks",
    description: "Create, list, or stop recurring background schedules",
    category: "Workspace & Tools",
    icon: "clock",
    action: "drill",
    keywords: ["schedule", "timer", "recurring", "automation"],
    children: [
      {
        key: "list",
        title: "List Scheduled Tasks",
        description: "Show all active recurring cron jobs",
        action: "execute",
        icon: "clock",
      },
      {
        key: "start",
        title: "Create Scheduled Task",
        description: "Start a new recurring task with an optional title",
        action: "fill",
        argsHint: "[title]",
        icon: "clock",
      },
      {
        key: "stop",
        title: "Stop Scheduled Task",
        description: "Cancel a scheduled task by ID or stop all",
        action: "fill",
        argsHint: "<id | all>",
        icon: "clock",
      },
    ],
  },
  {
    cmd: "/task",
    title: "Background Tasks",
    description: "List, inspect, or cancel durable runtime tasks",
    category: "Workspace & Tools",
    icon: "tasks",
    action: "drill",
    keywords: ["jobs", "runs", "cancel", "inspect"],
    children: [
      {
        key: "list",
        title: "List Tasks",
        description: "Show active and recent durable tasks",
        action: "execute",
        icon: "tasks",
      },
      {
        key: "inspect",
        title: "Inspect Task",
        description: "View detailed state for a specific task run ID",
        action: "fill",
        argsHint: "<run-id>",
        icon: "tasks",
      },
      {
        key: "cancel",
        title: "Cancel Task",
        description: "Stop a running task by its run ID",
        action: "fill",
        argsHint: "<run-id>",
        icon: "tasks",
      },
    ],
  },
  {
    cmd: "/skills",
    title: "Skills & Presets",
    description: "Browse or install built-in ufoo skills and workflows",
    category: "Workspace & Tools",
    icon: "skills",
    action: "drill",
    keywords: ["plugin", "workflow", "install", "builtin"],
    children: [
      {
        key: "list",
        title: "Browse Built-in Skills",
        description: "List available ufoo skills for discovery",
        action: "execute",
        icon: "skills",
      },
      {
        key: "install",
        title: "Install Skills",
        description: "Install a specific skill or 'all'",
        action: "fill",
        argsHint: "<name | all>",
        icon: "skills",
      },
    ],
  },
  {
    cmd: "/status",
    title: "Workspace Status",
    description: "Show active agents, tasks, and daemon health summary",
    category: "Workspace & Tools",
    icon: "pulse",
    action: "execute",
    keywords: ["health", "overview", "info", "state"],
  },
  {
    cmd: "/doctor",
    title: "Health Check",
    description: "Run diagnostics on workspace setup and AI providers",
    category: "Workspace & Tools",
    icon: "doctor",
    action: "execute",
    keywords: ["diagnose", "check", "debug", "repair", "fix"],
  },
  {
    cmd: "/settings",
    title: "Settings",
    description: "Inspect or update main agent and ucode configuration",
    category: "Workspace & Tools",
    icon: "settings",
    action: "drill",
    keywords: ["config", "preferences", "api", "key"],
    children: [
      {
        key: "show",
        title: "Settings Overview",
        description: "Display current provider, model, and runtime config",
        action: "execute",
        icon: "settings",
      },
      {
        key: "agent",
        title: "Main Agent Config",
        description: "Manage ufoo provider, model, and thinking level",
        action: "drill",
        icon: "provider",
        children: [
          {
            key: "show",
            title: "Show Main Agent Config",
            description: "Inspect active provider and model",
            action: "execute",
            icon: "pulse",
          },
          {
            key: "model",
            title: "Select Model",
            description: "Choose a model for the active provider",
            action: "drill",
            icon: "model",
            dynamic: true,
          },
          {
            key: "thinking",
            title: "Thinking Effort",
            description: "Select reasoning intensity level",
            action: "drill",
            icon: "skills",
            dynamic: true,
          },
          {
            key: "codex",
            title: "Use Codex Default",
            description: "Switch main agent to default Codex model",
            action: "execute",
            brand: "codex",
          },
          {
            key: "claude",
            title: "Use Claude Default",
            description: "Switch main agent to default Claude model",
            action: "execute",
            brand: "claude",
          },
          {
            key: "set",
            title: "Set Provider / Model",
            description: "Set provider and model directly",
            action: "fill",
            argsHint: "provider=<codex|claude> model=<id>",
            icon: "settings",
          },
          {
            key: "custom",
            title: "Custom API Endpoint",
            description: "Configure custom API URL and key",
            action: "fill",
            argsHint: "url=<api-url> key=<api-key>",
            icon: "settings",
          },
          {
            key: "clear",
            title: "Reset Agent Config",
            description: "Clear custom agent model or provider override",
            action: "execute",
            icon: "eraser",
          },
        ],
      },
      {
        key: "ucode",
        title: "ucode Provider Config",
        description: "Manage native ucode model, base URL, and key",
        action: "drill",
        brand: "ucode",
        children: [
          {
            key: "show",
            title: "Show ucode Config",
            description: "Display ucode provider, model, and endpoint",
            action: "execute",
            brand: "ucode",
          },
          {
            key: "models",
            title: "List Provider Models",
            description: "Fetch available models from the configured endpoint",
            action: "execute",
            icon: "model",
          },
          {
            key: "set",
            title: "Update ucode Config",
            description: "Set ucode provider, model, URL, or API key",
            action: "fill",
            argsHint: "provider=<id> model=<id>",
            icon: "settings",
          },
          {
            key: "clear",
            title: "Reset ucode Config",
            description: "Clear custom ucode provider overrides",
            action: "execute",
            icon: "eraser",
          },
        ],
      },
    ],
  },
  {
    cmd: "/mcp",
    title: "MCP Bridge",
    description: "Inspect global MCP bridge status and exposed tools",
    category: "Workspace & Tools",
    icon: "mcp",
    action: "drill",
    keywords: ["bridge", "tools", "server", "external"],
    children: [
      {
        key: "status",
        title: "MCP Bridge Status",
        description: "Show global MCP server connection state",
        action: "execute",
        icon: "mcp",
      },
      {
        key: "tools",
        title: "List MCP Tools",
        description: "Display all tools exposed via the ufoo MCP bridge",
        action: "execute",
        icon: "tasks",
      },
      {
        key: "help",
        title: "MCP Setup Guide",
        description: "Show setup instructions for external AI clients",
        action: "execute",
        icon: "context",
      },
    ],
  },
  {
    cmd: "/daemon",
    title: "Daemon Service",
    description: "Inspect or restart the local ufoo background daemon",
    category: "Workspace & Tools",
    icon: "daemon",
    action: "drill",
    keywords: ["service", "restart", "background", "server"],
    children: [
      {
        key: "status",
        title: "Daemon Status",
        description: "Check whether the background daemon is healthy",
        action: "execute",
        icon: "pulse",
      },
      {
        key: "restart",
        title: "Restart Daemon",
        description: "Cleanly restart the local GlobalDaemon",
        action: "execute",
        icon: "daemon",
      },
      {
        key: "start",
        title: "Start Daemon",
        description: "Start the local daemon if stopped",
        action: "execute",
        icon: "daemon",
      },
      {
        key: "stop",
        title: "Stop Daemon",
        description: "Stop the running local daemon",
        action: "execute",
        icon: "daemon",
      },
    ],
  },
  {
    cmd: "/init",
    title: "Initialize Workspace",
    description: "Create .ufoo project configuration in this repository",
    category: "Workspace & Tools",
    icon: "folder",
    action: "execute",
    keywords: ["setup", "bootstrap", "create"],
  },

  // ── Hidden TUI/internal commands (still match when explicitly typed) ──
  {
    cmd: "/open",
    title: "Open Project Path",
    description: "Open another project directory in global mode",
    category: "Workspace & Tools",
    icon: "folder",
    action: "fill",
    argsHint: "<project-path>",
    keywords: ["project", "directory", "folder"],
    hiddenByDefault: true,
  },
  {
    cmd: "/project",
    title: "Switch Project",
    description: "List or switch between running projects",
    category: "Workspace & Tools",
    icon: "folder",
    action: "drill",
    keywords: ["workspace", "switch"],
    hiddenByDefault: true,
    children: [
      { key: "current", title: "Current Project", description: "Show active project path", action: "execute", icon: "folder" },
      { key: "list", title: "List Projects", description: "List running projects from registry", action: "execute", icon: "folder" },
      { key: "switch", title: "Switch Project", description: "Switch active project by index or path", action: "fill", argsHint: "<index | path>", icon: "folder" },
    ],
  },
  {
    cmd: "/answer",
    title: "Answer Interaction",
    description: "Reply to a pending runtime approval or question by ID",
    category: "Workspace & Tools",
    icon: "terminal",
    action: "fill",
    argsHint: "<interaction-id> <reply>",
    keywords: ["approval", "respond"],
    hiddenByDefault: true,
  },
  {
    cmd: "/app",
    title: "Desktop App Handoff",
    description: "Hand off current project to Ufoo Desktop",
    category: "Workspace & Tools",
    icon: "terminal",
    action: "execute",
    keywords: ["desktop", "gui"],
    hiddenByDefault: true,
  },
  {
    cmd: "/ufoo",
    title: "ufoo Protocol",
    description: "Show ufoo workspace protocol overview",
    category: "Workspace & Tools",
    icon: "terminal",
    action: "execute",
    keywords: ["protocol"],
    hiddenByDefault: true,
  },
];

const COMMAND_BY_KEY = new Map<string, CommandDef>(COMMAND_DEFS.map((d) => [d.cmd, d]));

function renderItemIcon(item: Pick<ComposerMenuItem, "icon" | "brand" | "brandColor">) {
  if (item.brand) {
    return <BrandIcon brand={item.brand} color={item.brandColor} size={15} />;
  }
  const props = { size: 15, className: "text-zinc-400 shrink-0" };
  switch (item.icon) {
    case "rocket":
      return <RocketLaunch {...props} />;
    case "group":
      return <UsersThree {...props} />;
    case "user":
      return <UserCircle {...props} />;
    case "resume":
      return <ClockCounterClockwise {...props} />;
    case "role":
      return <Sparkle {...props} />;
    case "bus":
      return <Broadcast {...props} />;
    case "chat":
      return <ChatCircleDots {...props} />;
    case "eraser":
      return <Eraser {...props} />;
    case "layout":
      return <Columns {...props} />;
    case "model":
      return <Cpu {...props} />;
    case "provider":
      return <SlidersHorizontal {...props} />;
    case "context":
      return <BookOpen {...props} />;
    case "clock":
      return <Clock {...props} />;
    case "tasks":
      return <ListChecks {...props} />;
    case "skills":
      return <Sparkle {...props} />;
    case "pulse":
      return <Pulse {...props} />;
    case "doctor":
      return <Pulse {...props} />;
    case "settings":
      return <GearSix {...props} />;
    case "mcp":
      return <PlugsConnected {...props} />;
    case "daemon":
      return <ArrowsClockwise {...props} />;
    case "folder":
      return <FolderOpen {...props} />;
    case "flow":
      return <FlowArrow {...props} />;
    default:
      return <Terminal {...props} />;
  }
}

function prettifyDynamicTitle(head: string, rawLabel: string): { title: string; fallbackDesc: string } {
  const cleanLabel = rawLabel.trim();
  const stripped = cleanLabel.startsWith(`${head} `)
    ? cleanLabel.slice(head.length + 1).trim()
    : cleanLabel;
  if (head === "/model" || head.endsWith(" thinking")) {
    const parts = stripped.split(/\s+/);
    const last = parts[parts.length - 1]?.toLowerCase() || "";
    if (THINKING_LABELS[last]) {
      return {
        title: THINKING_LABELS[last].title,
        fallbackDesc: THINKING_LABELS[last].desc,
      };
    }
  }
  return { title: stripped || cleanLabel, fallbackDesc: "" };
}

function findActiveMentionToken(
  input: string,
  cursor: number
): { query: string; start: number; end: number } | null {
  const pos = Math.max(0, Math.min(cursor, input.length));
  const before = input.slice(0, pos);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] || "";
  const start = pos - query.length - 1;
  return { query, start, end: pos };
}

export function resolveComposerMenu({
  input,
  cursor,
  workers,
  workerColorMap = {},
  backendCompletions,
  backendCompletionsText,
  dismissed,
  scope,
}: {
  input: string;
  cursor: number;
  workers: WorkerSummary[];
  workerColorMap?: Record<string, string>;
  backendCompletions: CompletionItem[];
  backendCompletionsText: string;
  dismissed: boolean;
  scope: "controller" | "project";
}): ComposerMenuState {
  if (dismissed || !input) {
    return { mode: "none", breadcrumb: [], items: [], needsDynamicFetch: false };
  }

  const trimmedStart = input.trimStart();

  // ── 1. Slash command mode ──────────────────────────────────────────
  if (trimmedStart.startsWith("/")) {
    const endsWithSpace = /\s$/.test(trimmedStart);
    const tokens = trimmedStart.trimEnd().split(/\s+/).filter(Boolean);
    const headRaw = tokens[0] || "/";
    const headLower = headRaw.toLowerCase();

    // Case A: Top-level browsing or filtering ("/" or "/la", without trailing space)
    if (tokens.length <= 1 && !endsWithSpace) {
      const query = headLower.slice(1);
      const matched = COMMAND_DEFS.filter((def) => {
        if (def.hiddenByDefault && !query) return false;
        if (scope === "controller" && (def.cmd === "/bus" || def.cmd === "/role")) return false;
        if (!query) return true;
        const bare = def.cmd.slice(1).toLowerCase();
        if (bare.startsWith(query) || bare.includes(query)) return true;
        if (def.title.toLowerCase().includes(query)) return true;
        if (def.description.toLowerCase().includes(query)) return true;
        return def.keywords.some((kw) => kw.includes(query));
      });

      // Rank exact/prefix command matches above fuzzy title/keyword matches
      if (query) {
        matched.sort((a, b) => {
          const aBare = a.cmd.slice(1).toLowerCase();
          const bBare = b.cmd.slice(1).toLowerCase();
          const aScore = aBare === query ? 0 : aBare.startsWith(query) ? 1 : a.title.toLowerCase().startsWith(query) ? 2 : 3;
          const bScore = bBare === query ? 0 : bBare.startsWith(query) ? 1 : b.title.toLowerCase().startsWith(query) ? 2 : 3;
          if (aScore !== bScore) return aScore - bScore;
          return a.title.localeCompare(b.title);
        });
      }

      const items: ComposerMenuItem[] = matched.map((def) => ({
        id: def.cmd,
        title: def.title,
        description: def.description,
        command: def.cmd,
        replace: def.action === "execute" ? def.cmd : `${def.cmd} `,
        category: query ? undefined : def.category,
        action: def.action,
        argsHint: def.argsHint,
        icon: def.icon,
      }));

      return {
        mode: items.length > 0 ? "commands" : "none",
        breadcrumb: [{ label: "Commands", targetInput: "/" }],
        items,
        needsDynamicFetch: false,
      };
    }

    // Case B: Subcommand / argument mode ("/group ", "/group r", "/group run ", "/resume ", "/model ", etc.)
    const cmdDef = COMMAND_BY_KEY.get(headLower);
    const breadcrumb: BreadcrumbSegment[] = [{ label: "Commands", targetInput: "/" }];
    if (cmdDef) {
      breadcrumb.push({ label: cmdDef.title, targetInput: `${cmdDef.cmd} ` });
    } else {
      breadcrumb.push({ label: headRaw, targetInput: `${headRaw} ` });
    }

    // Walk static subcommand tree as far as committed segments go
    const tail = tokens.slice(1);
    let currentChildren: SubcommandDef[] | undefined = cmdDef?.children;
    let activeDef: {
      title: string;
      description: string;
      action: "drill" | "execute" | "fill";
      argsHint?: string;
      dynamic?: boolean;
      icon?: IconKey;
      brand?: string;
    } | undefined = cmdDef;
    let prefixPath = cmdDef ? cmdDef.cmd : headRaw;

    const committedSegments = endsWithSpace ? tail : tail.slice(0, -1);
    let partial = endsWithSpace ? "" : (tail[tail.length - 1] || "").toLowerCase();
    let walkedCleanly = true;

    for (const seg of committedSegments) {
      const match = currentChildren?.find((c) => c.key.toLowerCase() === seg.toLowerCase());
      if (!match) {
        walkedCleanly = false;
        break;
      }
      prefixPath = `${prefixPath} ${match.key}`;
      breadcrumb.push({ label: match.title, targetInput: `${prefixPath} ` });
      activeDef = match;
      currentChildren = match.children;
    }

    // B1: We are at a node with static child subcommands!
    if (walkedCleanly && currentChildren && currentChildren.length > 0) {
      const filtered = currentChildren.filter((sub) => {
        if (!partial) return true;
        return (
          sub.key.toLowerCase().startsWith(partial) ||
          sub.key.toLowerCase().includes(partial) ||
          sub.title.toLowerCase().includes(partial) ||
          sub.description.toLowerCase().includes(partial)
        );
      });

      const items: ComposerMenuItem[] = filtered.map((sub) => ({
        id: `${prefixPath} ${sub.key}`,
        title: sub.title,
        description: sub.description,
        command: `${prefixPath} ${sub.key}`,
        replace: sub.action === "execute" ? `${prefixPath} ${sub.key}` : `${prefixPath} ${sub.key} `,
        action: sub.action,
        argsHint: sub.argsHint,
        icon: sub.icon || cmdDef?.icon,
        brand: sub.brand,
      }));

      return {
        mode: items.length > 0 ? "commands" : "none",
        breadcrumb,
        items,
        needsDynamicFetch: false,
      };
    }

    // B2: Free-text argument fill command (e.g. "/bus send <agent> <message>")
    if (activeDef && activeDef.action === "fill" && activeDef.argsHint) {
      // Also allow @agent mention picker while typing the agent arg!
      const mention = findActiveMentionToken(input, cursor);
      if (mention && workers.length > 0) {
        return buildMentionState(workers, mention);
      }
      return {
        mode: "arg_hint",
        breadcrumb,
        items: [],
        argHint: {
          title: activeDef.title,
          command: prefixPath,
          argsHint: activeDef.argsHint,
          description: activeDef.description,
        },
        needsDynamicFetch: false,
      };
    }

    // B3: Dynamic backend argument list (/group run, /solo run, /resume, /model, /settings agent model|thinking)
    const isDynamic = Boolean(activeDef?.dynamic);
    const hasFreshBackend = backendCompletionsText === input;

    if (isDynamic || (hasFreshBackend && backendCompletions.length > 0)) {
      if (headLower === "/model" && committedSegments.length >= 1) {
        const modelArg = committedSegments[0];
        breadcrumb.push({ label: modelArg, targetInput: `/model ${modelArg} ` });
      }
      const rawList = hasFreshBackend ? backendCompletions : [];
      const items: ComposerMenuItem[] = rawList.map((item, idx) => {
        const label = String(item.label || item.cmd || item.value || "").trim();
        const replace = String(item.replace || (label ? `${label} ` : ""));
        const rawDesc = String(item.description || item.desc || "").trim();
        const { title, fallbackDesc } = prettifyDynamicTitle(prefixPath, label);
        const hasMore = Boolean(item.hasChildren);
        return {
          id: `${label}-${idx}`,
          title,
          description: rawDesc || fallbackDesc,
          command: label,
          replace: hasMore ? (replace.endsWith(" ") ? replace : `${replace} `) : label,
          action: hasMore ? "drill" : "execute",
          icon: activeDef?.icon || cmdDef?.icon || "flow",
          brand: activeDef?.brand,
        };
      });

      const emptyLabel =
        headLower === "/resume"
          ? "No recoverable sessions or groups found"
          : headLower === "/group"
          ? "No group templates found in this workspace"
          : headLower === "/solo"
          ? "No solo role profiles found"
          : headLower === "/model"
          ? "No models reported by current provider"
          : "No matching options";

      return {
        mode: "commands",
        breadcrumb,
        items,
        needsDynamicFetch: isDynamic && !hasFreshBackend,
        dynamicEmptyText: emptyLabel,
      };
    }

    // Completed leaf command (e.g. "/status " or "/clear") — hide popup so Enter submits directly
    return { mode: "none", breadcrumb: [], items: [], needsDynamicFetch: false };
  }

  // ── 2. @Agent mention mode (start of line OR mid-sentence!) ────────
  const mention = findActiveMentionToken(input, cursor);
  if (mention && workers.length > 0) {
    return buildMentionState(workers, mention, workerColorMap);
  }

  return { mode: "none", breadcrumb: [], items: [], needsDynamicFetch: false };
}

function buildMentionState(
  workers: WorkerSummary[],
  mention: { query: string; start: number; end: number },
  workerColorMap: Record<string, string> = {}
): ComposerMenuState {
  const q = mention.query.toLowerCase();
  const matched = workers.filter((w) => {
    if (!q) return true;
    return w.label.toLowerCase().includes(q) || w.id.toLowerCase().includes(q) || w.type.toLowerCase().includes(q);
  });

  if (matched.length === 0) {
    return { mode: "none", breadcrumb: [], items: [], needsDynamicFetch: false };
  }

  const items: ComposerMenuItem[] = matched.map((w) => {
    const working = w.activity_state === "working";
    return {
      id: `mention:${w.id}`,
      title: w.label,
      description: w.activity_detail || (w.external ? "External MCP agent" : `${w.type} worker`),
      command: `@${w.label}`,
      replace: `@${w.label} `,
      action: "mention",
      brand: w.type,
      brandColor: workerColorMap[w.id],
      metaBadge: w.external ? "MCP" : undefined,
      statusDot: working ? "working" : "ready",
    };
  });

  return {
    mode: "mentions",
    breadcrumb: [{ label: "Mention Agent", targetInput: "" }],
    items,
    needsDynamicFetch: false,
    mentionRange: { start: mention.start, end: mention.end },
  };
}

interface ComposerCommandMenuProps {
  menu: ComposerMenuState;
  activeIndex: number;
  onHoverIndex: (idx: number) => void;
  onSelectItem: (item: ComposerMenuItem, mode: "primary" | "fillOnly") => void;
  onNavigateBreadcrumb: (targetInput: string) => void;
  onDismiss: () => void;
}

export function ComposerCommandMenu({
  menu,
  activeIndex,
  onHoverIndex,
  onSelectItem,
  onNavigateBreadcrumb,
  onDismiss,
}: ComposerCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const activeEl = container.querySelector<HTMLElement>(`[data-cmd-idx="${activeIndex}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, menu.items.length]);

  if (menu.mode === "none") return null;

  // Compact inline argument helper bar for free-form commands like "/bus send <agent> <message>"
  if (menu.mode === "arg_hint" && menu.argHint) {
    const { title, command, argsHint, description } = menu.argHint;
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-white/[0.09] bg-[#141418]/95 px-3 py-2 text-[12px] shadow-lg backdrop-blur-xl">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-zinc-200 shrink-0">{title}</span>
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-zinc-300 shrink-0">
            {command} <span className="text-zinc-400">{argsHint}</span>
          </span>
          <span className="hidden sm:inline truncate text-[11.5px] text-zinc-500">
            {description}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Esc
        </button>
      </div>
    );
  }

  const hasSubmenuBreadcrumb = menu.mode === "commands" && menu.breadcrumb.length > 1;
  const parentSegment = hasSubmenuBreadcrumb
    ? menu.breadcrumb[menu.breadcrumb.length - 2]
    : null;

  return (
    <div
      onMouseDown={(e) => {
        // Keep focus inside textarea when clicking menu items
        e.preventDefault();
      }}
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#131317]/98 shadow-[0_18px_48px_rgba(0,0,0,0.58)] backdrop-blur-xl z-30"
    >
      {/* Clean Header / Breadcrumb Bar */}
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {parentSegment && (
            <button
              type="button"
              onClick={() => onNavigateBreadcrumb(parentSegment.targetInput)}
              title={`Back to ${parentSegment.label}`}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <ArrowLeft size={12} />
            </button>
          )}
          <div className="flex items-center gap-1 text-[11.5px] min-w-0 truncate">
            {menu.breadcrumb.map((seg, i) => {
              const isLast = i === menu.breadcrumb.length - 1;
              return (
                <React.Fragment key={`${seg.label}-${i}`}>
                  {i > 0 && <CaretRight size={10} className="shrink-0 text-zinc-600" />}
                  {isLast || !seg.targetInput ? (
                    <span className="font-medium text-zinc-200 truncate">{seg.label}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onNavigateBreadcrumb(seg.targetInput)}
                      className="text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer truncate"
                    >
                      {seg.label}
                    </button>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-zinc-500">
          {menu.needsDynamicFetch
            ? "Loading…"
            : `${menu.items.length} ${menu.items.length === 1 ? "option" : "options"}`}
        </span>
      </div>

      {/* Scrollable Friendly Command / Mention List */}
      <div ref={listRef} className="max-h-[300px] overflow-y-auto p-1.5">
        {menu.needsDynamicFetch && menu.items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-7 text-[12px] text-zinc-400">
            <DotGridLoader size="sm" colorClass="bg-zinc-300" />
            <span>Loading available options…</span>
          </div>
        ) : menu.items.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-zinc-500">
            {menu.dynamicEmptyText || "No matching commands"}
          </div>
        ) : (
          menu.items.map((item, idx) => {
            const active = idx === activeIndex;
            const prevCategory = idx > 0 ? menu.items[idx - 1].category : undefined;
            const showCategory = Boolean(item.category && item.category !== prevCategory);

            return (
              <React.Fragment key={item.id}>
                {showCategory && (
                  <div
                    className={`px-2.5 pb-1 text-[10.5px] font-medium tracking-wide text-zinc-500 ${
                      idx === 0 ? "pt-1" : "pt-2.5"
                    }`}
                  >
                    {item.category}
                  </div>
                )}
                <button
                  type="button"
                  data-cmd-idx={idx}
                  onMouseEnter={() => onHoverIndex(idx)}
                  onClick={() => onSelectItem(item, "primary")}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer ${
                    active ? "bg-white/[0.09] text-white" : "text-zinc-200 hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                        active
                          ? "border-white/[0.12] bg-white/[0.08]"
                          : "border-white/[0.06] bg-white/[0.03]"
                      }`}
                    >
                      {renderItemIcon(item)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[12.5px] font-medium text-zinc-100 truncate">
                          {item.title}
                        </span>
                        {item.metaBadge && (
                          <span className="rounded bg-white/[0.07] px-1 py-0.5 font-mono text-[9.5px] text-zinc-400">
                            {item.metaBadge}
                          </span>
                        )}
                        {item.statusDot === "working" && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
                        )}
                      </div>
                      {item.description && (
                        <div className="text-[11px] text-zinc-400 truncate">
                          {item.description}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Side: Subtle command tag + clear action affordance */}
                  <div className="flex items-center gap-2 shrink-0">
                    {item.argsHint && (
                      <span className="hidden sm:inline rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        {item.argsHint}
                      </span>
                    )}
                    {menu.mode === "commands" && (
                      <span className="hidden md:inline font-mono text-[10.5px] text-zinc-500">
                        {item.command}
                      </span>
                    )}
                    {item.action === "drill" ? (
                      <CaretRight
                        size={12}
                        className={active ? "text-zinc-200" : "text-zinc-600"}
                      />
                    ) : item.action === "execute" ? (
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-opacity ${
                          active
                            ? "bg-white/[0.1] text-zinc-200 opacity-100"
                            : "text-zinc-500 opacity-0"
                        }`}
                      >
                        Run ↵
                      </span>
                    ) : item.action === "mention" ? (
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-opacity ${
                          active
                            ? "bg-white/[0.1] text-zinc-200 opacity-100"
                            : "text-zinc-500 opacity-0"
                        }`}
                      >
                        Mention ↵
                      </span>
                    ) : (
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-opacity ${
                          active
                            ? "bg-white/[0.1] text-zinc-200 opacity-100"
                            : "text-zinc-500 opacity-0"
                        }`}
                      >
                        Fill ↵
                      </span>
                    )}
                  </div>
                </button>
              </React.Fragment>
            );
          })
        )}
      </div>

      {/* Subtle Keyboard Hints Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] bg-white/[0.015] px-3 py-1.5 text-[10.5px] text-zinc-500">
        <div className="flex items-center gap-3">
          <span>
            <kbd className="font-mono text-zinc-400">↑↓</kbd> Navigate
          </span>
          <span>
            <kbd className="font-mono text-zinc-400">↵</kbd>{" "}
            {menu.mode === "mentions" ? "Insert" : "Open / Run"}
          </span>
          {menu.mode === "commands" && (
            <span>
              <kbd className="font-mono text-zinc-400">Tab</kbd> Fill
            </span>
          )}
        </div>
        <span>
          <kbd className="font-mono text-zinc-400">Esc</kbd> Close
        </span>
      </div>
    </div>
  );
}
