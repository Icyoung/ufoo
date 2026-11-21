import React, { createContext, useContext, useEffect, useMemo, useReducer, useCallback } from "react";
import { ufooBridge } from "../bridge/ufooClient";
import { DEFAULT_WORKER_AGENT, WORKER_AGENTS, type WorkerAgent } from "../workerAgents";
import type {
  CompletionItem,
  MultiPaneFrame,
  PendingInteraction,
  ProjectTreeNode,
  RightInspectorTab,
  SettingsSnapshot,
  StageTarget,
  TranscriptEntry,
  UiEnvelope,
  WindowMode,
  WorkerViewFrame,
  WorkspaceChangesSnapshot,
  WorkspaceContextSnapshot,
  WorkspaceDocsSnapshot,
} from "../types";

export interface WorkspaceState {
  connected: boolean;
  packageVersion: string;
  statusText: string;
  busy: boolean;
  controllerRoot: string;
  activeRoot: string;
  scope: "controller" | "project";
  stageTarget: StageTarget;
  projects: ProjectTreeNode[];
  entries: TranscriptEntry[];
  promptPrefix: string;
  targetAgent: string;
  pendingInteraction: PendingInteraction | null;
  planLines: string[];
  windowMode: WindowMode;
  sideAgentId: string;
  focusedPaneAgentId: string;
  paneFrames: Record<string, MultiPaneFrame>;
  localPaneDrafts: Record<string, { text: string; rev: number }>;
  workerSingleFrame: WorkerViewFrame | null;
  settings: SettingsSnapshot;
  defaultWorkerAgent: WorkerAgent;
  completions: CompletionItem[];
  cronTasks: Array<{ id: string; label: string; summary: string }>;
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  rightTab: RightInspectorTab;
  changesSnapshot: WorkspaceChangesSnapshot | null;
  docsSnapshot: WorkspaceDocsSnapshot | null;
  contextSnapshot: WorkspaceContextSnapshot | null;
  settingsModalOpen: boolean;
  toastMessage: string;
}

const initialState: WorkspaceState = {
  connected: false,
  packageVersion: "",
  statusText: "Connecting to GlobalDaemon…",
  busy: false,
  controllerRoot: "",
  activeRoot: "",
  scope: "controller",
  stageTarget: { kind: "project_main", agentId: "" },
  projects: [],
  entries: [],
  promptPrefix: "› ",
  targetAgent: "",
  pendingInteraction: null,
  planLines: [],
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
  },
  defaultWorkerAgent: DEFAULT_WORKER_AGENT,
  completions: [],
  cronTasks: [],
  leftSidebarOpen: true,
  rightInspectorOpen: true,
  rightTab: "changes",
  changesSnapshot: null,
  docsSnapshot: null,
  contextSnapshot: null,
  settingsModalOpen: false,
  toastMessage: "",
};

type Action =
  | { type: "ENVELOPE"; envelope: UiEnvelope }
  | { type: "TOGGLE_LEFT_SIDEBAR" }
  | { type: "TOGGLE_RIGHT_INSPECTOR"; open?: boolean }
  | { type: "SET_RIGHT_TAB"; tab: RightInspectorTab }
  | { type: "SET_SETTINGS_MODAL"; open: boolean }
  | { type: "SET_DEFAULT_WORKER_AGENT"; agent: WorkerAgent }
  | { type: "SET_STAGE_TARGET_OPTIMISTIC"; target: StageTarget }
  | { type: "SET_WINDOW_MODE_OPTIMISTIC"; mode: WindowMode; sideAgentId?: string }
  | { type: "UPDATE_LOCAL_PANE_DRAFT"; agentId: string; text: string }
  | { type: "TOGGLE_ENTRY_EXPAND"; id: string }
  | { type: "SET_TARGET_AGENT"; agentId: string; prefix: string }
  | { type: "SHOW_TOAST"; message: string };

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "TOGGLE_LEFT_SIDEBAR":
      return { ...state, leftSidebarOpen: !state.leftSidebarOpen };
    case "TOGGLE_RIGHT_INSPECTOR":
      return {
        ...state,
        rightInspectorOpen: action.open !== undefined ? action.open : !state.rightInspectorOpen,
      };
    case "SET_RIGHT_TAB":
      return { ...state, rightTab: action.tab, rightInspectorOpen: true };
    case "SET_SETTINGS_MODAL":
      return { ...state, settingsModalOpen: action.open };
    case "SET_DEFAULT_WORKER_AGENT":
      return { ...state, defaultWorkerAgent: action.agent };
    case "SET_STAGE_TARGET_OPTIMISTIC":
      return { ...state, stageTarget: action.target };
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
    case "SHOW_TOAST":
      return { ...state, toastMessage: action.message };

    case "ENVELOPE": {
      const { name, kind, payload } = action.envelope;
      if (kind === "welcome") {
        return {
          ...state,
          connected: true,
          packageVersion: String(payload.package_version || state.packageVersion),
          statusText: "ready",
        };
      }
      if (name === "app.snapshot") {
        const win = payload.window || {};
        return {
          ...state,
          connected: true,
          packageVersion: String(payload.package_version || state.packageVersion),
          statusText: String(payload.status || "ready"),
          controllerRoot: String(payload.controller_root || state.controllerRoot),
          activeRoot: String(payload.active_root || state.activeRoot),
          scope: payload.scope === "project" ? "project" : "controller",
          stageTarget: payload.stage_target || state.stageTarget,
          entries: Array.isArray(payload.entries) ? payload.entries : state.entries,
          settings: payload.settings || state.settings,
          pendingInteraction: payload.pending_interaction || null,
          cronTasks: Array.isArray(payload.cron) ? payload.cron : state.cronTasks,
          windowMode: (win.mode as WindowMode) || "main",
          projects: Array.isArray(payload.projects) ? payload.projects : state.projects,
        };
      }
      if (name === "projects.tree") {
        return {
          ...state,
          connected: true,
          controllerRoot: String(payload.controller_root || state.controllerRoot),
          activeRoot: String(payload.active_root || state.activeRoot),
          scope: payload.scope === "project" ? "project" : "controller",
          stageTarget: payload.stage_target || state.stageTarget,
          projects: Array.isArray(payload.projects) ? payload.projects : state.projects,
        };
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
          entries: state.entries.map((e) =>
            !id || e.id === id ? { ...e, streaming: false } : e
          ),
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
        const exists = state.entries.some((e) => e.id === id);
        return {
          ...state,
          entries: exists
            ? state.entries.map((e) => (e.id === id ? { ...e, text: summary, detail } : e))
            : [...state.entries, { id, kind: "tool", text: summary, detail, expanded: false }],
        };
      }
      if (name === "status.set") {
        return {
          ...state,
          statusText: String(payload.text || "ready"),
          busy: typeof payload.busy === "boolean" ? payload.busy : state.busy,
        };
      }
      if (name === "prompt.set_prefix") {
        return { ...state, promptPrefix: String(payload.prefix || "› ") };
      }
      if (name === "interaction.request") {
        return { ...state, pendingInteraction: payload as PendingInteraction };
      }
      if (name === "interaction.clear") {
        return { ...state, pendingInteraction: null };
      }
      if (name === "plan.set") {
        return { ...state, planLines: Array.isArray(payload.lines) ? payload.lines : [] };
      }
      if (name === "settings.snapshot") {
        return { ...state, settings: { ...state.settings, ...payload } };
      }
      if (name === "completions.set") {
        return { ...state, completions: Array.isArray(payload.items) ? payload.items : [] };
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
        return {
          ...state,
          stageTarget: { kind: "worker_single", agentId: frame.agent_id },
          workerSingleFrame: frame,
        };
      }
      if (name === "handoff.state") {
        return {
          ...state,
          activeRoot: String(payload.project_root || state.activeRoot),
          stageTarget: payload.stage_target || state.stageTarget,
          windowMode: (payload.window_mode as WindowMode) || state.windowMode,
          ...(payload.doc_path ? { rightTab: "docs" as RightInspectorTab, rightInspectorOpen: true } : {}),
        };
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
      return state;
    }
    default:
      return state;
  }
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  dispatch: React.Dispatch<Action>;
  selectProjectMain: (root: string) => Promise<void>;
  selectWorkerView: (root: string, agentId: string) => Promise<void>;
  setWindowMode: (mode: WindowMode, agentId?: string) => Promise<void>;
  selectSideWorker: (agentId: string) => Promise<void>;
  submitMainInput: (text: string) => Promise<void>;
  submitWorkerInput: (agentId: string, text: string) => Promise<void>;
  cancelWorkerTurn: (agentId: string) => Promise<void>;
  openDocInInspector: (filePath: string) => Promise<void>;
  continueInCli: (agentId?: string) => Promise<void>;
  setDefaultWorkerAgent: (agent: WorkerAgent) => void;
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
    const unsub = ufooBridge.subscribe((envelope) => {
      dispatch({ type: "ENVELOPE", envelope });
    });
    void ufooBridge.init();
    return unsub;
  }, []);

  const selectProjectMain = useCallback(async (root: string) => {
    dispatch({ type: "SET_STAGE_TARGET_OPTIMISTIC", target: { kind: "project_main", agentId: "" } });
    await ufooBridge.sendCommand("worker.focus_view", { root, agent_id: "main" });
  }, []);

  const selectWorkerView = useCallback(async (root: string, agentId: string) => {
    dispatch({ type: "SET_STAGE_TARGET_OPTIMISTIC", target: { kind: "worker_single", agentId } });
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

  const submitMainInput = useCallback(
    async (text: string) => {
      await ufooBridge.sendCommand("input.submit", {
        text,
        target_agent: state.targetAgent || "",
        input_target: state.targetAgent ? "agent" : "main",
      });
    },
    [state.targetAgent]
  );

  const submitWorkerInput = useCallback(
    async (agentId: string, text: string) => {
      const prev = state.localPaneDrafts[agentId] || { text: "", rev: 0 };
      const nextRev = prev.rev + 1;
      dispatch({ type: "UPDATE_LOCAL_PANE_DRAFT", agentId, text: "" });
      await ufooBridge.sendCommand("multi.raw", {
        agent_id: agentId,
        input: text,
        cursor: text.length,
        input_revision: nextRev,
        submit: true,
      });
    },
    [state.localPaneDrafts]
  );

  const cancelWorkerTurn = useCallback(async (agentId: string) => {
    await ufooBridge.sendCommand("multi.cancel", { agent_id: agentId });
    notifyToast(`Stopped current turn on ${agentId}`);
  }, [notifyToast]);

  const openDocInInspector = useCallback(async (filePath: string) => {
    dispatch({ type: "SET_RIGHT_TAB", tab: "docs" });
    await ufooBridge.sendCommand("workspace.docs", { filePath });
  }, []);

  const continueInCli = useCallback(async (agentId = "") => {
    const res = await ufooBridge.sendCommand<{
      ok: boolean;
      terminal?: string;
      appName?: string;
      method?: string;
      error?: string;
    }>(
      "handoff.to_cli",
      agentId ? { agent_id: agentId } : {}
    );
    if (res?.ok && res.method === "app") {
      notifyToast(`Opened ${res.appName}. Select the worker’s session there.`);
    } else if (res?.ok && !res.method) {
      notifyToast(`Handed off to ${res.terminal || "Terminal"}`);
    } else if (res?.error) {
      notifyToast(res.error);
    }
  }, [notifyToast]);

  const value = useMemo(
    () => ({
      state,
      dispatch,
      selectProjectMain,
      selectWorkerView,
      setWindowMode,
      selectSideWorker,
      submitMainInput,
      submitWorkerInput,
      cancelWorkerTurn,
      openDocInInspector,
      continueInCli,
      setDefaultWorkerAgent,
      notifyToast,
    }),
    [
      state,
      selectProjectMain,
      selectWorkerView,
      setWindowMode,
      selectSideWorker,
      submitMainInput,
      submitWorkerInput,
      cancelWorkerTurn,
      openDocInInspector,
      continueInCli,
      setDefaultWorkerAgent,
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
