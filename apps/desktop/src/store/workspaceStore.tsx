import React, { createContext, useContext, useEffect, useMemo, useReducer, useCallback } from "react";
import {
  ufooBridge,
  type RemoteDeepLinkParams,
  type RemoteTransportSnapshot,
} from "../bridge/ufooClient";
import { DEFAULT_WORKER_AGENT, WORKER_AGENTS, type WorkerAgent } from "../workerAgents";
import type {
  BridgeTransportMode,
  CompletionItem,
  BackgroundTask,
  ComposerAttachment,
  ConnectionState,
  DiffViewMode,
  EngineCatalogItem,
  MobileTab,
  MultiPaneFrame,
  OnboardingProbeState,
  PendingInteraction,
  PermissionMode,
  PlanItem,
  ProjectTreeNode,
  QueuedMessageItem,
  QueuedMessagesSnapshot,
  RemotePairingState,
  RemoteStatusSnapshot,
  RightInspectorTab,
  SettingsSnapshot,
  SettingsTabId,
  StageTarget,
  TranscriptEntry,
  UiEnvelope,
  WindowMode,
  WorkerViewFrame,
  WorkflowPulse,
  WorkflowSnapshot,
  WorkspaceChangesSnapshot,
  WorkspaceContextSnapshot,
  WorkspaceDocsSnapshot,
} from "../types";

const DEFAULT_ENGINES: EngineCatalogItem[] = [
  { id: "codex", agentType: "codex", label: "Codex", kind: "sdk", available: true, description: "OpenAI Codex SDK" },
  { id: "claude", agentType: "claude", label: "Claude Code", kind: "sdk", available: true, description: "Anthropic Claude Agent SDK" },
  { id: "ucode", agentType: "ucode", label: "ucode", kind: "native", available: true, description: "ufoo Native Coding Engine" },
];

export interface NavHistoryEntry {
  scope: "controller" | "project";
  root: string;
  stageTarget: StageTarget;
}

export interface WorkspaceState {
  connected: boolean;
  connectionState: ConnectionState;
  transportMode: BridgeTransportMode;
  remoteDeviceId: string;
  remoteDeviceName: string;
  remoteHostFingerprint: string;
  remoteRelayUrl: string;
  remoteError: string;
  remotePairingState: RemotePairingState;
  remoteHasSavedSession: boolean;
  remoteRouteDeviceId: string;
  remoteDeepLink: RemoteDeepLinkParams | null;
  remoteStatus: RemoteStatusSnapshot | null;
  packageVersion: string;
  statusText: string;
  busy: boolean;
  controllerRoot: string;
  activeRoot: string;
  scope: "controller" | "project";
  stageTarget: StageTarget;
  projects: ProjectTreeNode[];
  engineCatalog: EngineCatalogItem[];
  entries: TranscriptEntry[];
  promptPrefix: string;
  targetAgent: string;
  pendingInteraction: PendingInteraction | null;
  pendingInteractions: PendingInteraction[];
  planLines: string[];
  planItems: PlanItem[];
  backgroundTasks: BackgroundTask[];
  queuedMessages: QueuedMessagesSnapshot;
  windowMode: WindowMode;
  sideAgentId: string;
  focusedPaneAgentId: string;
  paneFrames: Record<string, MultiPaneFrame>;
  localPaneDrafts: Record<string, { text: string; rev: number }>;
  workerSingleFrame: WorkerViewFrame | null;
  settings: SettingsSnapshot;
  defaultWorkerAgent: WorkerAgent;
  completions: CompletionItem[];
  completionsText: string;
  cronTasks: Array<{ id: string; label: string; summary: string }>;
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  rightTab: RightInspectorTab;
  diffViewMode: DiffViewMode;
  leftSidebarWidth: number;
  rightInspectorWidth: number;
  mobileDrawerOpen: boolean;
  mobileTab: MobileTab;
  approvalInboxOpen: boolean;
  changesSnapshot: WorkspaceChangesSnapshot | null;
  docsSnapshot: WorkspaceDocsSnapshot | null;
  contextSnapshot: WorkspaceContextSnapshot | null;
  workflowSnapshot: WorkflowSnapshot;
  workflowPulses: WorkflowPulse[];
  settingsModalOpen: boolean;
  settingsInitialTab: SettingsTabId;
  commandPaletteOpen: boolean;
  onboardingOpen: boolean;
  onboardingProbe: OnboardingProbeState | null;
  toastMessage: string;
  navHistory: NavHistoryEntry[];
  navIndex: number;
  navPendingKey: string;
  navPendingUntil: number;
}

const initialTransport = ufooBridge.getTransportSnapshot();

const initialState: WorkspaceState = {
  connected: false,
  connectionState: initialTransport.mode === "unpaired" ? "offline" : "connecting",
  transportMode: initialTransport.mode,
  remoteDeviceId: initialTransport.deviceId,
  remoteDeviceName: initialTransport.deviceName,
  remoteHostFingerprint: initialTransport.hostFingerprint,
  remoteRelayUrl: initialTransport.relayUrl,
  remoteError: initialTransport.error,
  remotePairingState: initialTransport.pairingState,
  remoteHasSavedSession: initialTransport.hasSavedSession,
  remoteRouteDeviceId: initialTransport.routeDeviceId,
  remoteDeepLink: initialTransport.deepLinkParams,
  remoteStatus: null,
  packageVersion: "",
  statusText: "Connecting to GlobalDaemon…",
  busy: false,
  controllerRoot: "",
  activeRoot: "",
  scope: "controller",
  stageTarget: { kind: "project_main", agentId: "" },
  projects: [],
  engineCatalog: DEFAULT_ENGINES,
  entries: [],
  promptPrefix: "› ",
  targetAgent: "",
  pendingInteraction: null,
  pendingInteractions: [],
  planLines: [],
  planItems: [],
  backgroundTasks: [],
  queuedMessages: { project_root: "", main: { items: [], paused: false }, workers: {} },
  windowMode: "main",
  sideAgentId: "",
  focusedPaneAgentId: "",
  paneFrames: {},
  localPaneDrafts: {},
  workerSingleFrame: null,
  settings: {
    agent_provider: "codex-cli",
    agent_model: "gpt-6.1-sol",
    agent_thinking: "medium",
    worktree_policy: "never",
    permission_mode: "auto_edit",
  },
  defaultWorkerAgent: DEFAULT_WORKER_AGENT,
  completions: [],
  completionsText: "",
  cronTasks: [],
  leftSidebarOpen: true,
  rightInspectorOpen: true,
  rightTab: "changes",
  diffViewMode: "unified",
  leftSidebarWidth: 264,
  rightInspectorWidth: 390,
  mobileDrawerOpen: false,
  mobileTab: "chat",
  approvalInboxOpen: false,
  changesSnapshot: null,
  docsSnapshot: null,
  contextSnapshot: null,
  workflowSnapshot: { project_root: "", groups: [], edges: [], positions: {} },
  workflowPulses: [],
  settingsModalOpen: false,
  settingsInitialTab: "general",
  commandPaletteOpen: false,
  onboardingOpen: false,
  onboardingProbe: null,
  toastMessage: "",
  navHistory: [],
  navIndex: -1,
  navPendingKey: "",
  navPendingUntil: 0,
};

const MAX_NAV_HISTORY = 60;

function buildNavEntry(
  scope: "controller" | "project",
  activeRoot: string,
  stageTarget: StageTarget
): NavHistoryEntry | null {
  if (scope === "controller") {
    return {
      scope: "controller",
      root: "",
      stageTarget: { kind: "project_main", agentId: "" },
    };
  }
  const cleanRoot = String(activeRoot || "").trim();
  if (!cleanRoot) return null;
  if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
    return {
      scope: "project",
      root: cleanRoot,
      stageTarget: { kind: "worker_single", agentId: stageTarget.agentId },
    };
  }
  return {
    scope: "project",
    root: cleanRoot,
    stageTarget: { kind: "project_main", agentId: "" },
  };
}

function navEntryKey(entry: NavHistoryEntry | null): string {
  if (!entry) return "";
  if (entry.scope === "controller") return "controller";
  if (entry.stageTarget.kind === "worker_single" && entry.stageTarget.agentId) {
    return `project:${entry.root}:worker:${entry.stageTarget.agentId}`;
  }
  return `project:${entry.root}:main`;
}

function withNavHistory(nextState: WorkspaceState): WorkspaceState {
  const entry = buildNavEntry(nextState.scope, nextState.activeRoot, nextState.stageTarget);
  if (!entry) return nextState;
  const nextKey = navEntryKey(entry);
  const currentEntry =
    nextState.navIndex >= 0 && nextState.navIndex < nextState.navHistory.length
      ? nextState.navHistory[nextState.navIndex]
      : null;
  const currentKey = navEntryKey(currentEntry);

  if (nextKey === currentKey) {
    if (nextState.navPendingKey === nextKey) {
      return { ...nextState, navPendingKey: "", navPendingUntil: 0 };
    }
    return nextState;
  }

  const now = Date.now();
  if (nextState.navPendingKey && now < nextState.navPendingUntil) {
    if (nextKey === nextState.navPendingKey) {
      return { ...nextState, navPendingKey: "", navPendingUntil: 0 };
    }
    // Intermediate host envelope while navigating across projects/views; keep stack intact
    return nextState;
  }

  const base =
    nextState.navIndex >= 0 ? nextState.navHistory.slice(0, nextState.navIndex + 1) : [];
  let updated = [...base, entry];
  if (updated.length > MAX_NAV_HISTORY) {
    updated = updated.slice(updated.length - MAX_NAV_HISTORY);
  }
  return {
    ...nextState,
    navHistory: updated,
    navIndex: updated.length - 1,
    navPendingKey: "",
    navPendingUntil: 0,
  };
}

type Action =
  | { type: "ENVELOPE"; envelope: UiEnvelope }
  | { type: "TRANSPORT_UPDATE"; snapshot: RemoteTransportSnapshot }
  | { type: "TOGGLE_LEFT_SIDEBAR" }
  | { type: "TOGGLE_RIGHT_INSPECTOR"; open?: boolean }
  | { type: "SET_RIGHT_TAB"; tab: RightInspectorTab }
  | { type: "SET_DIFF_VIEW_MODE"; mode: DiffViewMode }
  | { type: "SET_LEFT_SIDEBAR_WIDTH"; width: number }
  | { type: "SET_RIGHT_INSPECTOR_WIDTH"; width: number }
  | { type: "SET_MOBILE_DRAWER"; open: boolean }
  | { type: "SET_MOBILE_TAB"; tab: MobileTab }
  | { type: "SET_APPROVAL_INBOX_OPEN"; open: boolean }
  | { type: "SET_SETTINGS_MODAL"; open: boolean; tab?: SettingsTabId }
  | { type: "SET_COMMAND_PALETTE"; open: boolean }
  | { type: "SET_ONBOARDING_OPEN"; open: boolean }
  | { type: "SET_ONBOARDING_PROBE"; probe: OnboardingProbeState }
  | { type: "SET_DEFAULT_WORKER_AGENT"; agent: WorkerAgent }
  | {
      type: "SET_STAGE_TARGET_OPTIMISTIC";
      target: StageTarget;
      root?: string;
      scope?: "controller" | "project";
    }
  | { type: "NAV_SET_INDEX"; index: number; target: NavHistoryEntry }
  | { type: "SET_WINDOW_MODE_OPTIMISTIC"; mode: WindowMode; sideAgentId?: string }
  | { type: "UPDATE_LOCAL_PANE_DRAFT"; agentId: string; text: string }
  | { type: "TOGGLE_ENTRY_EXPAND"; id: string }
  | { type: "SET_TARGET_AGENT"; agentId: string; prefix: string }
  | { type: "SET_MAIN_BUSY_OPTIMISTIC"; busy: boolean; statusText?: string }
  | { type: "CLEAR_COMPLETIONS" }
  | { type: "SHOW_TOAST"; message: string };

function normalizePendingInteractions(
  queueRaw: unknown,
  singleRaw: unknown
): PendingInteraction[] {
  if (Array.isArray(queueRaw)) {
    return queueRaw.filter((item): item is PendingInteraction => Boolean(item && typeof item === "object" && (item as any).id));
  }
  if (singleRaw && typeof singleRaw === "object" && (singleRaw as any).id) {
    return [singleRaw as PendingInteraction];
  }
  return [];
}

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "TRANSPORT_UPDATE": {
      const s = action.snapshot;
      return {
        ...state,
        transportMode: s.mode,
        remotePairingState: s.pairingState,
        remoteDeviceId: s.deviceId,
        remoteDeviceName: s.deviceName,
        remoteHostFingerprint: s.hostFingerprint,
        remoteRelayUrl: s.relayUrl,
        remoteError: s.error,
        remoteHasSavedSession: s.hasSavedSession,
        remoteRouteDeviceId: s.routeDeviceId,
        remoteDeepLink: s.deepLinkParams,
        ...(s.mode === "unpaired"
          ? {
              connected: false,
              connectionState: "offline" as ConnectionState,
            }
          : {}),
      };
    }
    case "TOGGLE_LEFT_SIDEBAR":
      return { ...state, leftSidebarOpen: !state.leftSidebarOpen };
    case "TOGGLE_RIGHT_INSPECTOR":
      return {
        ...state,
        rightInspectorOpen: action.open !== undefined ? action.open : !state.rightInspectorOpen,
      };
    case "SET_RIGHT_TAB":
      return { ...state, rightTab: action.tab, rightInspectorOpen: true };
    case "SET_DIFF_VIEW_MODE":
      return { ...state, diffViewMode: action.mode };
    case "SET_LEFT_SIDEBAR_WIDTH":
      return { ...state, leftSidebarWidth: Math.max(210, Math.min(420, Math.round(action.width))) };
    case "SET_RIGHT_INSPECTOR_WIDTH":
      return { ...state, rightInspectorWidth: Math.max(320, Math.min(820, Math.round(action.width))) };
    case "SET_MOBILE_DRAWER":
      return { ...state, mobileDrawerOpen: action.open };
    case "SET_MOBILE_TAB":
      return { ...state, mobileTab: action.tab };
    case "SET_APPROVAL_INBOX_OPEN":
      return { ...state, approvalInboxOpen: action.open };
    case "SET_SETTINGS_MODAL":
      return {
        ...state,
        settingsModalOpen: action.open,
        ...(action.tab ? { settingsInitialTab: action.tab } : {}),
      };
    case "SET_COMMAND_PALETTE":
      return { ...state, commandPaletteOpen: action.open };
    case "SET_ONBOARDING_OPEN":
      return { ...state, onboardingOpen: action.open };
    case "SET_ONBOARDING_PROBE":
      return { ...state, onboardingProbe: action.probe };
    case "SET_DEFAULT_WORKER_AGENT":
      return { ...state, defaultWorkerAgent: action.agent };
    case "SET_STAGE_TARGET_OPTIMISTIC": {
      const nextScope = action.scope ?? (action.root ? "project" : state.scope);
      const nextRoot = action.scope === "controller" ? state.controllerRoot : (action.root ?? state.activeRoot);
      const nextEntry = buildNavEntry(nextScope, nextRoot, action.target);
      const pendingKey = navEntryKey(nextEntry);
      const recorded = withNavHistory({
        ...state,
        scope: nextScope,
        activeRoot: nextRoot,
        stageTarget: action.target,
        workerSingleFrame: action.target.agentId === state.workerSingleFrame?.agent_id ? state.workerSingleFrame : null,
        navPendingKey: "",
        navPendingUntil: 0,
      });
      return {
        ...recorded,
        navPendingKey: pendingKey,
        navPendingUntil: pendingKey ? Date.now() + 1800 : 0,
      };
    }
    case "NAV_SET_INDEX": {
      const target = action.target;
      const pendingKey = navEntryKey(target);
      return {
        ...state,
        navIndex: action.index,
        navPendingKey: pendingKey,
        navPendingUntil: Date.now() + 1800,
        scope: target.scope,
        activeRoot: target.scope === "controller" ? state.controllerRoot : target.root,
        stageTarget: target.stageTarget,
        ...(target.stageTarget.kind === "project_main" ? { workerSingleFrame: null } : {}),
      };
    }
    case "SET_WINDOW_MODE_OPTIMISTIC":
      return {
        ...state,
        stageTarget: { kind: "project_main", agentId: "" },
        windowMode: action.mode,
        ...(action.sideAgentId ? { sideAgentId: action.sideAgentId } : {}),
      };
    case "UPDATE_LOCAL_PANE_DRAFT": {
      const prev = state.localPaneDrafts[action.agentId] || { text: "", rev: 0 };
      return {
        ...state,
        localPaneDrafts: {
          ...state.localPaneDrafts,
          [action.agentId]: { text: action.text, rev: prev.rev + 1 },
        },
      };
    }
    case "TOGGLE_ENTRY_EXPAND":
      return {
        ...state,
        entries: state.entries.map((item) =>
          item.id === action.id ? { ...item, expanded: !item.expanded } : item
        ),
      };
    case "SET_TARGET_AGENT":
      return { ...state, targetAgent: action.agentId, promptPrefix: action.prefix };
    case "SET_MAIN_BUSY_OPTIMISTIC":
      return {
        ...state,
        busy: action.busy,
        statusText: action.statusText || (action.busy ? "Thinking…" : "ready"),
      };
    case "CLEAR_COMPLETIONS":
      return { ...state, completions: [], completionsText: "" };
    case "SHOW_TOAST":
      return { ...state, toastMessage: action.message };

    case "ENVELOPE": {
      const { name, kind, payload } = action.envelope;
      if (kind === "welcome") {
        return {
          ...state,
          connected: true,
          connectionState: "connected",
          packageVersion: String(payload.package_version || state.packageVersion),
          statusText: "ready",
        };
      }
      if (name === "host.connection") {
        const raw = String(payload.state || (payload.connected ? "connected" : "reconnecting"));
        const nextConn: ConnectionState =
          raw === "connected" ? "connected"
          : raw === "offline" ? "offline"
          : raw === "connecting" ? "connecting"
          : "reconnecting";
        return {
          ...state,
          connected: nextConn === "connected",
          connectionState: nextConn,
          ...(typeof payload.device_name === "string" && payload.device_name
            ? { remoteDeviceName: payload.device_name }
            : {}),
          ...(typeof payload.device_id === "string" && payload.device_id
            ? { remoteDeviceId: payload.device_id }
            : {}),
        };
      }
      if (name === "remote.status") {
        return {
          ...state,
          remoteStatus: payload as RemoteStatusSnapshot,
        };
      }
      if (name === "app.snapshot") {
        const win = payload.window || {};
        const daemonConnected = payload.daemon_connected !== false;
        const nextConn: ConnectionState =
          payload.daemon_state === "offline" ? "offline"
          : payload.daemon_state === "reconnecting" ? "reconnecting"
          : daemonConnected ? "connected" : "reconnecting";
        const nextActiveRoot = String(payload.active_root || state.activeRoot);
        const switchedProject = Boolean(nextActiveRoot && state.activeRoot && nextActiveRoot !== state.activeRoot);
        const nextStageTarget = payload.stage_target || state.stageTarget;
        const nextQueue = normalizePendingInteractions(payload.pending_interactions, payload.pending_interaction);
        const nextHead = (payload.pending_interaction as PendingInteraction | null) || nextQueue[0] || null;
        return withNavHistory({
          ...state,
          connected: nextConn === "connected",
          connectionState: nextConn,
          packageVersion: String(payload.package_version || state.packageVersion),
          statusText: String(payload.status || "ready"),
          busy: typeof payload.busy === "boolean" ? payload.busy : false,
          controllerRoot: String(payload.controller_root || state.controllerRoot),
          activeRoot: nextActiveRoot,
          scope: payload.scope === "project" ? "project" : "controller",
          stageTarget: nextStageTarget,
          ...(switchedProject ? { targetAgent: "", promptPrefix: "› ", paneFrames: {} } : {}),
          ...(nextStageTarget.kind === "project_main" ? { workerSingleFrame: null } : {}),
          entries: Array.isArray(payload.entries) ? payload.entries : state.entries,
          settings: payload.settings || state.settings,
          pendingInteraction: nextHead,
          pendingInteractions: nextQueue,
          backgroundTasks: payload.background_tasks || [],
          queuedMessages:
            payload.queued_messages && typeof payload.queued_messages === "object"
              ? {
                  project_root: String(payload.queued_messages.project_root || nextActiveRoot),
                  main: {
                    items: Array.isArray(payload.queued_messages.main?.items) ? payload.queued_messages.main.items : [],
                    paused: Boolean(payload.queued_messages.main?.paused),
                  },
                  workers:
                    payload.queued_messages.workers && typeof payload.queued_messages.workers === "object"
                      ? payload.queued_messages.workers
                      : {},
                }
              : switchedProject
              ? { project_root: nextActiveRoot, main: { items: [], paused: false }, workers: {} }
              : state.queuedMessages,
          cronTasks: Array.isArray(payload.cron) ? payload.cron : state.cronTasks,
          windowMode: (win.mode as WindowMode) || "main",
          projects: Array.isArray(payload.projects) ? payload.projects : state.projects,
          engineCatalog: Array.isArray(payload.engine_catalog) && payload.engine_catalog.length > 0
            ? (payload.engine_catalog as EngineCatalogItem[])
            : state.engineCatalog,
          onboardingOpen: payload.onboarding_needed === true ? true : state.onboardingOpen,
          ...(payload.workflow ? { workflowSnapshot: payload.workflow as WorkflowSnapshot } : {}),
        });
      }
      if (name === "onboarding.state") {
        return {
          ...state,
          onboardingProbe: payload as OnboardingProbeState,
        };
      }
      if (name === "projects.tree") {
        const upgraded = state.connectionState === "connecting" ? "connected" : state.connectionState;
        return withNavHistory({
          ...state,
          connected: upgraded === "connected",
          connectionState: upgraded,
          controllerRoot: String(payload.controller_root || state.controllerRoot),
          activeRoot: String(payload.active_root || state.activeRoot),
          scope: payload.scope === "project" ? "project" : "controller",
          stageTarget: payload.stage_target || state.stageTarget,
          projects: Array.isArray(payload.projects) ? payload.projects : state.projects,
        });
      }
      if (name === "transcript.reset") {
        return { ...state, entries: Array.isArray(payload.entries) ? payload.entries : [] };
      }
      if (name === "transcript.append") {
        const entry = (payload.entry || payload) as TranscriptEntry;
        if (!entry || !entry.id) return state;
        const exists = state.entries.some((e) => e.id === entry.id);
        return {
          ...state,
          entries: exists
            ? state.entries.map((e) => (e.id === entry.id ? { ...e, ...entry } : e))
            : [...state.entries, entry],
        };
      }
      if (name === "stream.start") {
        const id = String(payload.id || `stream-${Date.now()}`);
        if (state.entries.some((e) => e.id === id)) return { ...state, busy: true };
        return {
          ...state,
          busy: true,
          entries: [
            ...state.entries,
            {
              id,
              kind: "assistant",
              speaker: String(payload.speaker || "ufoo"),
              text: "",
              streaming: true,
            },
          ],
        };
      }
      if (name === "stream.delta") {
        const id = String(payload.id || "");
        const delta = String(payload.text || payload.delta || "");
        const found = state.entries.some((e) => e.id === id);
        if (!found) {
          return {
            ...state,
            busy: true,
            entries: [
              ...state.entries,
              {
                id: id || `stream-${Date.now()}`,
                kind: "assistant",
                speaker: String(payload.speaker || "ufoo"),
                text: delta,
                streaming: true,
              },
            ],
          };
        }
        return {
          ...state,
          busy: true,
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, text: payload.reset ? delta : e.text + delta, streaming: true } : e
          ),
        };
      }
      if (name === "stream.done") {
        const id = String(payload.id || "");
        return {
          ...state,
          busy: false,
          entries: state.entries.map((e) => {
            if (!id || e.id === id) return { ...e, streaming: false };
            if (e.kind === "tool" && e.tool_status === "running") return { ...e, tool_status: "done" };
            return e;
          }),
        };
      }
      if (name === "thinking.start" || name === "thinking.delta") {
        const id = String(payload.id || "thinking-live");
        const chunk = String(payload.text || "");
        const found = state.entries.some((e) => e.id === id);
        if (!found) {
          return {
            ...state,
            busy: true,
            entries: [...state.entries, { id, kind: "thinking", text: chunk, expanded: false }],
          };
        }
        return {
          ...state,
          busy: true,
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, text: payload.reset ? chunk : e.text + chunk } : e
          ),
        };
      }
      if (name === "tool.start" || name === "tool.result" || name === "tool.group") {
        const id = String(payload.id || `tool-${Date.now()}`);
        const summary = String(payload.summary || payload.text || "Tool execution");
        const detail = String(payload.detail || payload.expanded_text || "");
        const toolName = payload.tool_name ? String(payload.tool_name) : undefined;
        const toolStatus = (payload.tool_status || (name === "tool.start" ? "running" : "done")) as
          | "running"
          | "done"
          | "error";
        const exists = state.entries.some((e) => e.id === id);
        return {
          ...state,
          busy: name === "tool.start" ? true : state.busy,
          entries: exists
            ? state.entries.map((e) =>
                e.id === id
                  ? {
                      ...e,
                      text: summary,
                      detail: detail || e.detail,
                      ...(toolName ? { tool_name: toolName } : {}),
                      tool_status: toolStatus,
                    }
                  : e
              )
            : [
                ...state.entries,
                {
                  id,
                  kind: "tool",
                  text: summary,
                  detail,
                  ...(toolName ? { tool_name: toolName } : {}),
                  tool_status: toolStatus,
                  expanded: false,
                },
              ],
        };
      }
      if (name === "status.set") {
        const nextBusy = typeof payload.busy === "boolean" ? payload.busy : state.busy;
        return {
          ...state,
          statusText: String(payload.text || "ready"),
          busy: nextBusy,
          ...(!nextBusy
            ? {
                entries: state.entries.map((e) =>
                  e.kind === "tool" && e.tool_status === "running"
                    ? { ...e, tool_status: "done" }
                    : e
                ),
              }
            : {}),
        };
      }
      if (name === "prompt.set_prefix") {
        return { ...state, promptPrefix: String(payload.prefix || "› ") };
      }
      if (name === "interaction.request") {
        const head = payload as PendingInteraction;
        const queue = normalizePendingInteractions(payload.queue, head);
        return {
          ...state,
          pendingInteraction: head && head.id ? head : (queue[0] || null),
          pendingInteractions: queue,
        };
      }
      if (name === "interaction.clear") {
        if (Array.isArray(payload?.queue)) {
          const nextQueue = normalizePendingInteractions(payload.queue, null);
          return {
            ...state,
            pendingInteractions: nextQueue,
            pendingInteraction: nextQueue[0] || null,
          };
        }
        const targetId = String(payload?.id || "").trim();
        if (targetId) {
          const nextQueue = state.pendingInteractions.filter((item) => item.id !== targetId);
          const nextHead =
            state.pendingInteraction && state.pendingInteraction.id !== targetId
              ? state.pendingInteraction
              : (nextQueue[0] || null);
          return {
            ...state,
            pendingInteraction: nextHead,
            pendingInteractions: nextQueue,
          };
        }
        return { ...state, pendingInteraction: null, pendingInteractions: [] };
      }
      if (name === "plan.set") {
        return {
          ...state,
          planLines: Array.isArray(payload.lines) ? payload.lines : [],
          planItems: Array.isArray(payload.items) ? (payload.items as PlanItem[]) : [],
        };
      }
      if (name === "tasks.snapshot" && payload.project_root === state.activeRoot) {
        return { ...state, backgroundTasks: payload.tasks };
      }
      if (name === "queue.snapshot") {
        return {
          ...state,
          queuedMessages: {
            project_root: String(payload.project_root || state.activeRoot),
            main: {
              items: Array.isArray(payload.main?.items) ? payload.main.items : [],
              paused: Boolean(payload.main?.paused),
            },
            workers:
              payload.workers && typeof payload.workers === "object"
                ? payload.workers
                : {},
          },
        };
      }
      if (name === "settings.snapshot") {
        return { ...state, settings: { ...state.settings, ...payload } };
      }
      if (name === "completions.set") {
        return {
          ...state,
          completions: Array.isArray(payload.items) ? payload.items : [],
          completionsText: String(payload.text || ""),
        };
      }
      if (name === "cron.snapshot") {
        return { ...state, cronTasks: Array.isArray(payload.tasks) ? payload.tasks : state.cronTasks };
      }
      if (name === "window.set") {
        const mode = (payload.mode as WindowMode) || "main";
        const panes = Array.isArray(payload.panes) ? payload.panes : [];
        const firstPaneId = panes[0]?.agent_id || "";
        return {
          ...state,
          windowMode: mode,
          sideAgentId: mode === "side" && firstPaneId ? firstPaneId : state.sideAgentId,
          focusedPaneAgentId: payload.focus?.target === "agent" ? String(payload.focus.agent_id || "") : "",
        };
      }
      if (name === "multi.pane.frame") {
        const frame = payload as MultiPaneFrame;
        if (!frame || !frame.agent_id) return state;
        return {
          ...state,
          paneFrames: {
            ...state.paneFrames,
            [frame.agent_id]: frame,
          },
          sideAgentId: state.windowMode === "side" && !state.sideAgentId ? frame.agent_id : state.sideAgentId,
        };
      }
      if (name === "worker.view.frame") {
        const frame = payload as WorkerViewFrame;
        return withNavHistory({
          ...state,
          ...(frame.project_root ? { activeRoot: frame.project_root, scope: "project" as const } : {}),
          stageTarget: { kind: "worker_single", agentId: frame.agent_id },
          workerSingleFrame: frame,
        });
      }
      if (name === "handoff.state") {
        return withNavHistory({
          ...state,
          activeRoot: String(payload.project_root || state.activeRoot),
          stageTarget: payload.stage_target || state.stageTarget,
          windowMode: (payload.window_mode as WindowMode) || state.windowMode,
          ...(payload.doc_path ? { rightTab: "docs" as RightInspectorTab, rightInspectorOpen: true } : {}),
        });
      }
      if (name === "workspace.changes.snapshot") {
        return { ...state, changesSnapshot: payload as WorkspaceChangesSnapshot };
      }
      if (name === "workspace.docs.snapshot") {
        return { ...state, docsSnapshot: payload as WorkspaceDocsSnapshot };
      }
      if (name === "workspace.context.snapshot") {
        return { ...state, contextSnapshot: payload as WorkspaceContextSnapshot };
      }
      if (name === "workflow.snapshot") {
        return {
          ...state,
          workflowSnapshot: {
            project_root: String(payload.project_root || ""),
            groups: Array.isArray(payload.groups) ? payload.groups : [],
            edges: Array.isArray(payload.edges) ? payload.edges : [],
            positions:
              payload.positions && typeof payload.positions === "object"
                ? payload.positions
                : state.workflowSnapshot.positions,
          },
        };
      }
      if (name === "workflow.pulse") {
        const pulse = payload as WorkflowPulse;
        if (!pulse || !pulse.from || !pulse.to) return state;
        const now = Date.now();
        const recent = state.workflowPulses.filter((p) => now - p.ts < 2000).slice(-12);
        return {
          ...state,
          workflowPulses: [...recent, { ...pulse, ts: pulse.ts || now }],
        };
      }
      return state;
    }
    default:
      return state;
  }
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  dispatch: React.Dispatch<Action>;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  selectController: () => Promise<void>;
  selectProjectMain: (root: string) => Promise<void>;
  selectWorkerView: (root: string, agentId: string) => Promise<void>;
  setWindowMode: (mode: WindowMode, agentId?: string) => Promise<void>;
  selectSideWorker: (agentId: string) => Promise<void>;
  submitMainInput: (
    text: string,
    attachments?: ComposerAttachment[],
    options?: { forceSend?: boolean }
  ) => Promise<void>;
  submitWorkerInput: (
    agentId: string,
    text: string,
    attachments?: ComposerAttachment[],
    options?: { forceSend?: boolean }
  ) => Promise<void>;
  removeQueuedMessage: (
    scope: "main" | "worker",
    id: string,
    agentId?: string
  ) => Promise<QueuedMessageItem | null>;
  clearQueuedMessages: (scope: "main" | "worker", agentId?: string) => Promise<void>;
  sendQueuedMessageNow: (scope: "main" | "worker", id?: string, agentId?: string) => Promise<void>;
  stageAttachments: (input: {
    paths?: string[];
    uploads?: Array<{ name: string; data_base64: string; media_type?: string }>;
  }) => Promise<ComposerAttachment[]>;
  cancelWorkerTurn: (agentId: string) => Promise<void>;
  openDocInInspector: (filePath: string) => Promise<void>;
  setDefaultWorkerAgent: (agent: WorkerAgent) => void;
  setPermissionMode: (mode: PermissionMode, agentId?: string) => Promise<void>;
  configureAgentRuntime: (
    agentId: string,
    patch: { model?: string; thinking_level?: string; permission_mode?: PermissionMode }
  ) => Promise<boolean>;
  handoffWorker: (sourceAgentId: string, targetEngine: string, note?: string) => Promise<void>;
  launchWorkerEngine: (agent: string, root?: string) => Promise<void>;
  respondInteraction: (
    id: string,
    answer: string,
    cancelled?: boolean,
    dismissAll?: boolean
  ) => Promise<void>;
  notifyToast: (msg: string) => void;
}

const WorkspaceCtx = createContext<WorkspaceContextValue | null>(null);
const DEFAULT_WORKER_STORAGE_KEY = "ufoo.desktop.defaultWorkerAgent";

function readDefaultWorkerAgent(): WorkerAgent {
  try {
    const saved = window.localStorage.getItem(DEFAULT_WORKER_STORAGE_KEY);
    return WORKER_AGENTS.find(({ id }) => id === saved)?.id ?? DEFAULT_WORKER_AGENT;
  } catch {
    return DEFAULT_WORKER_AGENT;
  }
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (initial) => ({
    ...initial,
    defaultWorkerAgent: readDefaultWorkerAgent(),
  }));

  const setDefaultWorkerAgent = useCallback((agent: WorkerAgent) => {
    window.localStorage.setItem(DEFAULT_WORKER_STORAGE_KEY, agent);
    dispatch({ type: "SET_DEFAULT_WORKER_AGENT", agent });
  }, []);

  const notifyToast = useCallback((message: string) => {
    dispatch({ type: "SHOW_TOAST", message });
    setTimeout(() => {
      dispatch({ type: "SHOW_TOAST", message: "" });
    }, 3200);
  }, []);

  useEffect(() => {
    const unsubEvents = ufooBridge.subscribe((envelope) => {
      dispatch({ type: "ENVELOPE", envelope });
    });
    const unsubTransport = ufooBridge.subscribeTransport((snapshot) => {
      dispatch({ type: "TRANSPORT_UPDATE", snapshot });
    });
    void ufooBridge.init();
    return () => {
      unsubEvents();
      unsubTransport();
    };
  }, []);

  const canGoBack = state.navIndex > 0;
  const canGoForward = state.navIndex >= 0 && state.navIndex < state.navHistory.length - 1;

  const navigateToHistoryIndex = useCallback(
    async (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= state.navHistory.length) return;
      const target = state.navHistory[nextIndex];
      if (!target) return;
      dispatch({ type: "SET_MOBILE_DRAWER", open: false });
      dispatch({ type: "NAV_SET_INDEX", index: nextIndex, target });
      if (target.scope === "controller") {
        await ufooBridge.sendCommand("project.return_controller", {});
        return;
      }
      if (target.stageTarget.kind === "worker_single" && target.stageTarget.agentId) {
        await ufooBridge.sendCommand("worker.focus_view", {
          root: target.root,
          agent_id: target.stageTarget.agentId,
        });
        return;
      }
      await ufooBridge.sendCommand("worker.focus_view", {
        root: target.root,
        agent_id: "main",
      });
    },
    [state.navHistory]
  );

  const goBack = useCallback(async () => {
    if (state.navIndex > 0) {
      await navigateToHistoryIndex(state.navIndex - 1);
    }
  }, [state.navIndex, navigateToHistoryIndex]);

  const goForward = useCallback(async () => {
    if (state.navIndex >= 0 && state.navIndex < state.navHistory.length - 1) {
      await navigateToHistoryIndex(state.navIndex + 1);
    }
  }, [state.navIndex, state.navHistory.length, navigateToHistoryIndex]);

  const selectController = useCallback(async () => {
    dispatch({ type: "SET_MOBILE_DRAWER", open: false });
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" });
    dispatch({
      type: "SET_STAGE_TARGET_OPTIMISTIC",
      scope: "controller",
      target: { kind: "project_main", agentId: "" },
    });
    await ufooBridge.sendCommand("project.return_controller", {});
  }, []);

  const selectProjectMain = useCallback(async (root: string) => {
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" });
    dispatch({ type: "SET_TARGET_AGENT", agentId: "", prefix: "› " });
    dispatch({ type: "SET_MOBILE_DRAWER", open: false });
    dispatch({
      type: "SET_STAGE_TARGET_OPTIMISTIC",
      scope: "project",
      root,
      target: { kind: "project_main", agentId: "" },
    });
    await ufooBridge.sendCommand("worker.focus_view", { root, agent_id: "main" });
  }, []);

  const selectWorkerView = useCallback(async (root: string, agentId: string) => {
    dispatch({ type: "SET_MOBILE_DRAWER", open: false });
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" });
    dispatch({
      type: "SET_STAGE_TARGET_OPTIMISTIC",
      scope: "project",
      root,
      target: { kind: "worker_single", agentId },
    });
    await ufooBridge.sendCommand("worker.focus_view", { root, agent_id: agentId });
  }, []);

  const setWindowMode = useCallback(async (mode: WindowMode, agentId = "") => {
    dispatch({ type: "SET_WINDOW_MODE_OPTIMISTIC", mode, sideAgentId: agentId });
    if (mode === "side" && agentId) {
      await ufooBridge.sendCommand("side.select", { agent_id: agentId });
    } else {
      await ufooBridge.sendCommand("window.set", { mode, agent_id: agentId });
    }
  }, []);

  const selectSideWorker = useCallback(async (agentId: string) => {
    dispatch({ type: "SET_WINDOW_MODE_OPTIMISTIC", mode: "side", sideAgentId: agentId });
    await ufooBridge.sendCommand("side.select", { agent_id: agentId });
  }, []);

  const stripAttachmentPreviews = (attachments?: ComposerAttachment[]) =>
    (Array.isArray(attachments) ? attachments : []).map(({ preview_data_url: _preview, ...rest }) => rest);

  const stageAttachments = useCallback(
    async (input: {
      paths?: string[];
      uploads?: Array<{ name: string; data_base64: string; media_type?: string }>;
    }): Promise<ComposerAttachment[]> => {
      try {
        const res = await ufooBridge.sendCommand<{
          ok?: boolean;
          attachments?: ComposerAttachment[];
          errors?: string[];
          error?: string;
        }>("attachment.stage", {
          paths: input.paths || [],
          uploads: input.uploads || [],
        });
        if (Array.isArray(res?.errors) && res.errors.length > 0) {
          notifyToast(res.errors[0]);
        } else if (!res?.ok && res?.error) {
          notifyToast(res.error);
        }
        return Array.isArray(res?.attachments) ? res.attachments : [];
      } catch (err) {
        notifyToast(err instanceof Error ? err.message : "Failed to attach files");
        return [];
      }
    },
    [notifyToast]
  );

  const submitMainInput = useCallback(
    async (text: string, attachments?: ComposerAttachment[], options?: { forceSend?: boolean }) => {
      const trimmed = text.trimStart();
      const isSlashCommand = trimmed.startsWith("/");
      const isShellCommand = trimmed.startsWith("!");
      const isAtMention = trimmed.startsWith("@");
      const target = isSlashCommand ? "" : state.targetAgent || "";
      const wireAttachments = stripAttachmentPreviews(attachments);
      if (
        !state.busy &&
        !isSlashCommand &&
        !isShellCommand &&
        !isAtMention &&
        !target &&
        (trimmed || wireAttachments.length > 0)
      ) {
        dispatch({ type: "SET_MAIN_BUSY_OPTIMISTIC", busy: true, statusText: "Thinking…" });
      }
      await ufooBridge.sendCommand("input.submit", {
        text,
        ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
        ...(options?.forceSend ? { force_send: true } : {}),
        target_agent: target,
        input_target: target ? "agent" : "main",
      });
    },
    [state.targetAgent, state.busy]
  );

  const submitWorkerInput = useCallback(
    async (
      agentId: string,
      text: string,
      attachments?: ComposerAttachment[],
      options?: { forceSend?: boolean }
    ) => {
      const prev = state.localPaneDrafts[agentId] || { text: "", rev: 0 };
      const nextRev = prev.rev + 1;
      const wireAttachments = stripAttachmentPreviews(attachments);
      dispatch({ type: "UPDATE_LOCAL_PANE_DRAFT", agentId, text: "" });
      await ufooBridge.sendCommand("multi.raw", {
        agent_id: agentId,
        input: text,
        ...(wireAttachments.length > 0 ? { attachments: wireAttachments } : {}),
        ...(options?.forceSend ? { force_send: true } : {}),
        cursor: text.length,
        input_revision: nextRev,
        submit: true,
      });
    },
    [state.localPaneDrafts]
  );

  const removeQueuedMessage = useCallback(
    async (scope: "main" | "worker", id: string, agentId = ""): Promise<QueuedMessageItem | null> => {
      try {
        const res = await ufooBridge.sendCommand<{ ok?: boolean; removed?: QueuedMessageItem | null }>(
          "queue.remove",
          { scope, id, ...(scope === "worker" && agentId ? { agent_id: agentId } : {}) }
        );
        return res?.removed || null;
      } catch {
        return null;
      }
    },
    []
  );

  const clearQueuedMessages = useCallback(
    async (scope: "main" | "worker", agentId = "") => {
      await ufooBridge.sendCommand("queue.clear", {
        scope,
        ...(scope === "worker" && agentId ? { agent_id: agentId } : {}),
      });
    },
    []
  );

  const sendQueuedMessageNow = useCallback(
    async (scope: "main" | "worker", id = "", agentId = "") => {
      await ufooBridge.sendCommand("queue.send_now", {
        scope,
        ...(id ? { id } : {}),
        ...(scope === "worker" && agentId ? { agent_id: agentId } : {}),
      });
    },
    []
  );

  const cancelWorkerTurn = useCallback(async (agentId: string) => {
    await ufooBridge.sendCommand("multi.cancel", { agent_id: agentId });
    notifyToast(`Stopped current turn on ${agentId}`);
  }, [notifyToast]);

  const openDocInInspector = useCallback(async (filePath: string) => {
    dispatch({ type: "SET_RIGHT_TAB", tab: "docs" });
    if (window.matchMedia("(max-width: 767px)").matches) dispatch({ type: "SET_MOBILE_TAB", tab: "changes" });
    await ufooBridge.sendCommand("workspace.docs", { filePath });
  }, []);

  const setPermissionMode = useCallback(async (mode: PermissionMode, agentId = "") => {
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>(
        "session.set_permission",
        agentId ? { mode, agent_id: agentId } : { mode }
      );
      if (res?.ok) {
        const labels: Record<PermissionMode, string> = {
          supervised: "Supervised",
          auto_edit: "Auto-Edit",
          full_access: "Full Access",
        };
        notifyToast(`Permission: ${labels[mode]}`);
      } else if (res?.error) {
        notifyToast(res.error);
      }
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : "Failed to update permission mode");
    }
  }, [notifyToast]);

  const configureAgentRuntime = useCallback(async (
    agentId: string,
    patch: { model?: string; thinking_level?: string; permission_mode?: PermissionMode }
  ): Promise<boolean> => {
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string; warning?: string }>(
        "worker.configure",
        { agent_id: agentId || "main", ...patch }
      );
      if (!res?.ok) {
        notifyToast(res?.error || "Failed to update agent configuration");
        return false;
      }
      if (res.warning) {
        notifyToast(res.warning);
      }
      return true;
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : "Failed to update agent configuration");
      return false;
    }
  }, [notifyToast]);

  const handoffWorker = useCallback(async (sourceAgentId: string, targetEngine: string, note = "") => {
    const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("worker.handoff", {
      source_agent_id: sourceAgentId,
      target_engine: targetEngine,
      note,
    });
    if (res?.ok) {
      notifyToast(`Handed off session to ${targetEngine}`);
    } else if (res?.error) {
      notifyToast(res.error);
    }
  }, [notifyToast]);

  const launchWorkerEngine = useCallback(async (agent: string, root?: string) => {
    const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>(
      "worker.launch",
      root ? { root, agent } : { agent }
    );
    if (res?.ok) {
      notifyToast(`Launched ${agent}`);
    } else if (res?.error) {
      notifyToast(res.error);
    }
  }, [notifyToast]);

  const respondInteraction = useCallback(
    async (id: string, answer: string, cancelled = false, dismissAll = false) => {
      await ufooBridge.sendCommand("interaction.respond", {
        id,
        text: answer,
        cancelled,
        ...(dismissAll ? { dismiss_all: true } : {}),
      });
    },
    []
  );

  const value = useMemo(
    () => ({
      state,
      dispatch,
      canGoBack,
      canGoForward,
      goBack,
      goForward,
      selectController,
      selectProjectMain,
      selectWorkerView,
      setWindowMode,
      selectSideWorker,
      submitMainInput,
      submitWorkerInput,
      removeQueuedMessage,
      clearQueuedMessages,
      sendQueuedMessageNow,
      stageAttachments,
      cancelWorkerTurn,
      openDocInInspector,
      setDefaultWorkerAgent,
      setPermissionMode,
      configureAgentRuntime,
      handoffWorker,
      launchWorkerEngine,
      respondInteraction,
      notifyToast,
    }),
    [
      state,
      canGoBack,
      canGoForward,
      goBack,
      goForward,
      selectController,
      selectProjectMain,
      selectWorkerView,
      setWindowMode,
      selectSideWorker,
      submitMainInput,
      submitWorkerInput,
      removeQueuedMessage,
      clearQueuedMessages,
      sendQueuedMessageNow,
      stageAttachments,
      cancelWorkerTurn,
      openDocInInspector,
      setDefaultWorkerAgent,
      setPermissionMode,
      configureAgentRuntime,
      handoffWorker,
      launchWorkerEngine,
      respondInteraction,
      notifyToast,
    ]
  );

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceCtx);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
