"use strict";

/**
 * Chat reducer — the entire bag of UI state needed to render ChatApp,
 * isolated as a pure function so jest can drive it through transitions
 * without mounting ink.
 *
 * Action types (kept simple and explicit; we don't mint constants because
 * the reducer is the only consumer):
 *   { type: "log/append", text }           append a log line
 *   { type: "log/appendMany", lines }      append multiple lines at once
 *   { type: "log/clear" }                  reset log to banner
 *   { type: "draft/set", value }
 *   { type: "draft/clear" }
 *   { type: "focus/toggle" }               Tab between input/dashboard
 *   { type: "focus/set", mode }            "input" | "dashboard"
 *   { type: "view/set", view }             projects|agents|mode|provider|resume|cron
 *   { type: "view/cycle", direction }      "left" | "right"
 *   { type: "agents/set", list }           list of {fullId, type, id, nickname, …}
 *   { type: "agents/select", index }
 *   { type: "agents/cycle", direction }
 *   { type: "agents/clearTarget" }
 *   { type: "agents/window", windowStart }
 *   { type: "projects/set", list, activeIndex }
 *   { type: "projects/select", index }
 *   { type: "scope/set", scope }           "controller" | "project"
 *   { type: "status/set", payload }        { message, type, showTimer, startedAt }
 *   { type: "status/idle" }
 *   { type: "history/push", value }
 *   { type: "history/setIndex", index }
 *   { type: "merge/append", entry }        tool merge add
 *   { type: "merge/flush" }                freeze active group into log
 *   { type: "merge/expand" }               Ctrl+O
 *   { type: "settings/set", patch }        merge launch mode / provider / autoResume
 */

const fmt = require("../format");

const LOG_CAP = 1000;
const HISTORY_CAP = 200;
const DASHBOARD_VIEWS = ["projects", "agents", "mode", "provider", "resume", "cron"];

function createInitialState({ banner = [], globalMode = false, globalScope = "controller" } = {}) {
  return {
    logLines: banner.concat([""]).map((line, idx) => ({ id: `b-${idx}`, text: line })),
    lineSeq: banner.length + 1,
    draft: "",
    focusMode: "input",
    dashboardView: globalMode ? "projects" : "agents",
    globalMode,
    globalScope,
    agents: [],
    activeAgentMeta: new Map(),
    selectedAgentIndex: -1,
    agentSelectionMode: false,
    agentListWindowStart: 0,
    projects: [],
    selectedProjectIndex: -1,
    projectListWindowStart: 0,
    activeProjectRoot: "",
    modeOptions: ["auto", "host", "terminal", "tmux", "internal-pty", "internal"],
    selectedModeIndex: 0,
    providerOptions: [],
    selectedProviderIndex: 0,
    resumeOptions: [],
    selectedResumeIndex: 0,
    cronTasks: [],
    selectedCronIndex: -1,
    viewingAgentId: null,
    // activeStream is the in-flight chunk-by-chunk publisher message (set
    // while the daemon is streaming). Rendered live below <Static>;
    // promoted to <Static> when the stream finishes the same way the
    // tool-merge group is.
    activeStream: null,
    inputHistory: [],
    historyIndex: 0,
    activeMerge: null,
    lastMerge: null,
    mergeId: 0,
    status: { message: "", type: "thinking", showTimer: false, startedAt: 0 },
    settings: { launchMode: "auto", agentProvider: "codex-cli", autoResume: false },
  };
}

function appendLog(state, lines) {
  const incoming = Array.isArray(lines) ? lines : [lines];
  let seq = state.lineSeq;
  const out = state.logLines.concat(incoming.map((text) => {
    const id = `l-${seq}`;
    seq += 1;
    return { id, text: String(text == null ? "" : text) };
  }));
  return {
    ...state,
    logLines: out.length > LOG_CAP ? out.slice(-LOG_CAP) : out,
    lineSeq: seq,
  };
}

function freezeMergeIntoLog(state) {
  if (!state.activeMerge) return state;
  const summary = fmt.buildToolMergeRowText(state.activeMerge.entries);
  return appendLog({ ...state, activeMerge: null }, summary);
}

function reducer(state, action) {
  if (!action || !action.type) return state;
  switch (action.type) {
    case "log/append":
      return appendLog(freezeMergeIntoLog(state), action.text);
    case "log/appendMany":
      return appendLog(freezeMergeIntoLog(state), action.lines);
    case "log/clear":
      return {
        ...state,
        logLines: [],
        lineSeq: 0,
        activeMerge: null,
      };
    case "draft/set":
      return { ...state, draft: String(action.value || "") };
    case "draft/clear":
      return { ...state, draft: "" };
    case "focus/toggle":
      return { ...state, focusMode: state.focusMode === "input" ? "dashboard" : "input" };
    case "focus/set":
      return { ...state, focusMode: action.mode === "dashboard" ? "dashboard" : "input" };
    case "view/set":
      return { ...state, dashboardView: action.view };
    case "view/cycle": {
      const i = DASHBOARD_VIEWS.indexOf(state.dashboardView);
      const direction = action.direction === "left" ? -1 : 1;
      const start = i < 0 ? 0 : i;
      const next = (start + direction + DASHBOARD_VIEWS.length) % DASHBOARD_VIEWS.length;
      return { ...state, dashboardView: DASHBOARD_VIEWS[next] };
    }
    case "agents/set": {
      const list = Array.isArray(action.list) ? action.list : [];
      const ids = list.map((a) => a.fullId || `${a.type}:${a.id}`);
      const meta = new Map(list.map((a) => [a.fullId || `${a.type}:${a.id}`, a]));
      let nextIdx = state.selectedAgentIndex;
      let nextMode = state.agentSelectionMode;
      if (ids.length === 0) {
        nextIdx = -1;
        nextMode = false;
      } else if (nextIdx >= ids.length) {
        nextIdx = ids.length - 1;
      }
      return {
        ...state,
        agents: ids,
        activeAgentMeta: meta,
        selectedAgentIndex: nextIdx,
        agentSelectionMode: nextMode,
      };
    }
    case "agents/select":
      return {
        ...state,
        selectedAgentIndex: action.index,
        agentSelectionMode: action.index >= 0,
      };
    case "agents/cycle": {
      if (state.agents.length === 0) return state;
      const next = fmt.cycleAgentSelectionIndex(
        state.selectedAgentIndex,
        state.agents.length,
        action.direction
      );
      return { ...state, selectedAgentIndex: next, agentSelectionMode: true };
    }
    case "agents/clearTarget":
      return { ...state, selectedAgentIndex: -1, agentSelectionMode: false };
    case "agents/window":
      return { ...state, agentListWindowStart: action.windowStart };
    case "projects/set":
      return {
        ...state,
        projects: Array.isArray(action.list) ? action.list : [],
        activeProjectRoot: action.activeProjectRoot || state.activeProjectRoot,
      };
    case "projects/select":
      return { ...state, selectedProjectIndex: action.index };
    case "projects/window":
      return { ...state, projectListWindowStart: Math.max(0, action.windowStart | 0) };
    case "scope/set":
      return { ...state, globalScope: action.scope === "project" ? "project" : "controller" };
    case "status/set":
      return { ...state, status: { ...state.status, ...action.payload } };
    case "status/idle":
      return { ...state, status: { message: "", type: "thinking", showTimer: false, startedAt: 0 } };
    case "history/push": {
      const value = String(action.value || "").trim();
      if (!value) return state;
      const next = state.inputHistory.concat([value]).slice(-HISTORY_CAP);
      return { ...state, inputHistory: next, historyIndex: next.length };
    }
    case "history/load": {
      const list = Array.isArray(action.list) ? action.list : [];
      const next = list.slice(-HISTORY_CAP);
      return { ...state, inputHistory: next, historyIndex: next.length };
    }
    case "history/setIndex":
      return { ...state, historyIndex: Math.max(0, Math.min(state.inputHistory.length, action.index)) };
    case "merge/append": {
      const entry = fmt.normalizeToolMergeEntry(action.entry || {});
      let next;
      if (state.activeMerge) {
        next = { ...state.activeMerge, entries: state.activeMerge.entries.concat([entry]) };
      } else {
        next = { id: state.mergeId + 1, entries: [entry], expanded: false };
      }
      const lastMerge = next.entries.length >= 2 ? next : state.lastMerge;
      return {
        ...state,
        activeMerge: next,
        lastMerge,
        mergeId: state.activeMerge ? state.mergeId : state.mergeId + 1,
      };
    }
    case "merge/flush":
      return freezeMergeIntoLog(state);
    case "merge/expand": {
      const candidate = (state.activeMerge && !state.activeMerge.expanded && state.activeMerge.entries.length >= 2)
        ? state.activeMerge
        : (state.lastMerge && !state.lastMerge.expanded && state.lastMerge.entries.length >= 2
            ? state.lastMerge
            : null);
      if (!candidate) return state;
      const lines = fmt.buildMergedToolExpandedLines(candidate.entries).map((line, i, arr) =>
        `${i === arr.length - 1 ? "└" : "│"} ${line}`
      );
      const after = appendLog(state, lines);
      return {
        ...after,
        activeMerge: state.activeMerge && state.activeMerge.id === candidate.id ? null : state.activeMerge,
        lastMerge: state.lastMerge && state.lastMerge.id === candidate.id
          ? { ...state.lastMerge, expanded: true }
          : state.lastMerge,
      };
    }
    case "settings/set":
      return { ...state, settings: { ...state.settings, ...(action.patch || {}) } };
    case "cron/set":
      return { ...state, cronTasks: Array.isArray(action.list) ? action.list : [] };
    case "stream/begin":
      return {
        ...state,
        activeStream: { publisher: action.publisher || "", text: "" },
      };
    case "stream/delta": {
      if (!state.activeStream) {
        return {
          ...state,
          activeStream: { publisher: action.publisher || "", text: String(action.delta || "") },
        };
      }
      return {
        ...state,
        activeStream: {
          ...state.activeStream,
          text: state.activeStream.text + String(action.delta || ""),
        },
      };
    }
    case "stream/end": {
      if (!state.activeStream) return state;
      const lines = String(state.activeStream.text || "").split(/\r?\n/);
      const prefix = state.activeStream.publisher
        ? `${state.activeStream.publisher}: `
        : "";
      const annotated = prefix && lines.length > 0
        ? [`${prefix}${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)]
        : lines;
      const next = appendLog(state, annotated);
      return { ...next, activeStream: null };
    }
    case "agentView/enter":
      return { ...state, viewingAgentId: action.agentId || null };
    case "agentView/exit":
      return { ...state, viewingAgentId: null };
    default:
      return state;
  }
}

module.exports = { reducer, createInitialState, DASHBOARD_VIEWS };
