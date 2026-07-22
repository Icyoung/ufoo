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
 *   { type: "view/set", view }             projects|agents|mode|provider|cron
 *   { type: "view/cycle", direction }      "left" | "right"
 *   { type: "agents/set", list }           list of {fullId, type, id, nickname, …}
 *   { type: "agents/select", index }
 *   { type: "agents/cycle", direction }
 *   { type: "agents/clearTarget" }
 *   { type: "agents/window", windowStart }
 *   { type: "projects/set", list, activeProjectRoot }
 *   { type: "projects/select", index, projectRoot }
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
const { createChatLogEntry } = require("./chatLogModel");

const LOG_CAP = 1000;
const HISTORY_CAP = 200;
const DASHBOARD_VIEWS = ["projects", "agents", "mode", "provider", "cron"];
const DEFAULT_PROVIDER_OPTIONS = [
  { label: "codex", value: "codex-cli" },
  { label: "claude", value: "claude-cli" },
  { label: "agy", value: "agy-cli" },
  { label: "kimi", value: "kimi-cli" },
];
function projectRootOf(row = {}) {
  return String((row && (row.root || row.project_root || row.projectRoot)) || "");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function shallowArrayEqual(left = [], right = []) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function listPayloadEqual(left = [], right = []) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (stableJson(left[i]) !== stableJson(right[i])) return false;
  }
  return true;
}

function mapPayloadEqual(left, right) {
  if (left === right) return true;
  if (!(left instanceof Map) || !(right instanceof Map)) return false;
  if (left.size !== right.size) return false;
  for (const [key, value] of left.entries()) {
    if (!right.has(key)) return false;
    if (stableJson(value) !== stableJson(right.get(key))) return false;
  }
  return true;
}

function statusPayloadEqual(left, right) {
  const normalize = (value = {}) => {
    const normalized = { ...value };
    if (normalized.showTimer !== true) normalized.startedAt = 0;
    return normalized;
  };
  return stableJson(normalize(left)) === stableJson(normalize(right));
}

function createInitialState({ banner = [], globalMode = false, globalScope = "controller", settings = {} } = {}) {
  const initialLaunchMode = settings.launchMode || "auto";
  const initialAgentProvider = settings.agentProvider || "codex-cli";
  const selectedProviderIndex = Math.max(0, DEFAULT_PROVIDER_OPTIONS.findIndex((opt) => opt.value === initialAgentProvider));
  const seed = Array.isArray(banner) ? banner.concat([""]) : [""];
  return {
    logLines: seed.map((line, idx) => {
      // History reload may pass structured `{ text, sourceType }` rows —
      // don't wrap those objects as `text` (that yields "[object Object]").
      if (line && typeof line === "object" && !Array.isArray(line)) {
        return createChatLogEntry(line, `b-${idx}`);
      }
      return createChatLogEntry({
        text: line,
        sourceType: "banner",
      }, `b-${idx}`);
    }),
    lineSeq: seed.length,
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
    selectedProjectRoot: "",
    projectListWindowStart: 0,
    emptyProjectsDownArmed: false,
    activeProjectRoot: "",
    modeOptions: ["auto", "host", "terminal", "tmux", "internal"],
    selectedModeIndex: Math.max(0, ["auto", "host", "terminal", "tmux", "internal"].indexOf(initialLaunchMode)),
    providerOptions: DEFAULT_PROVIDER_OPTIONS,
    selectedProviderIndex,
    cronTasks: [],
    selectedCronIndex: -1,
    loopSummary: null,
    viewingAgentId: null,
    // activeStream is the in-flight chunk-by-chunk publisher message (set
    // while the daemon is streaming). Rendered live below <Static>;
    // promoted to <Static> when the stream finishes the same way the
    // tool-merge group is. Text accumulates in `chunks` (joined on read via
    // activeStreamText) so each delta dispatch is O(1) instead of O(n)
    // string concatenation.
    activeStream: null,
    inputHistory: [],
    historyIndex: 0,
    activeMerge: null,
    lastMerge: null,
    mergeId: 0,
    status: { message: "", type: "thinking", showTimer: false, startedAt: 0 },
    settings: { launchMode: initialLaunchMode, agentProvider: initialAgentProvider, autoResume: settings.autoResume === true },
  };
}

function appendLog(state, lines) {
  const incoming = Array.isArray(lines) ? lines : [lines];
  let seq = state.lineSeq;
  const out = state.logLines.concat(incoming.map((line) => {
    const id = `l-${seq}`;
    seq += 1;
    return createChatLogEntry(line, id);
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

// Joined text of the in-flight stream. Deltas accumulate in `chunks` so the
// reducer never does per-delta string concatenation (O(n²) over a stream);
// readers pay a single O(n) join when they actually need the text.
function activeStreamText(stream) {
  if (!stream || typeof stream !== "object") return "";
  if (Array.isArray(stream.chunks)) return stream.chunks.join("");
  return String(stream.text || "");
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
      return {
        ...state,
        focusMode: state.focusMode === "input" ? "dashboard" : "input",
        emptyProjectsDownArmed: state.focusMode === "input" ? state.emptyProjectsDownArmed : false,
      };
    case "focus/set":
      return {
        ...state,
        focusMode: action.mode === "dashboard" ? "dashboard" : "input",
        emptyProjectsDownArmed: action.mode === "dashboard" ? state.emptyProjectsDownArmed : false,
      };
    case "view/set": {
      const view = action.view;
      const inAgentsView = view === "agents";
      return {
        ...state,
        dashboardView: view,
        agentSelectionMode: inAgentsView && state.focusMode === "dashboard" && state.selectedAgentIndex >= 0,
        emptyProjectsDownArmed: view === "projects" ? state.emptyProjectsDownArmed : false,
      };
    }
    case "view/cycle": {
      const i = DASHBOARD_VIEWS.indexOf(state.dashboardView);
      const direction = action.direction === "left" ? -1 : 1;
      const start = i < 0 ? 0 : i;
      const next = Math.max(0, Math.min(DASHBOARD_VIEWS.length - 1, start + direction));
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
      if (
        shallowArrayEqual(state.agents, ids) &&
        mapPayloadEqual(state.activeAgentMeta, meta) &&
        state.selectedAgentIndex === nextIdx &&
        state.agentSelectionMode === nextMode
      ) {
        return state;
      }
      return {
        ...state,
        agents: ids,
        activeAgentMeta: meta,
        selectedAgentIndex: nextIdx,
        agentSelectionMode: nextMode,
      };
    }
    case "agents/patchMeta": {
      const agentId = String(action.agentId || "").trim();
      if (!agentId) return state;
      const patch = action.patch || {};
      const patchKeys = Object.keys(patch);
      const current = (state.activeAgentMeta instanceof Map ? state.activeAgentMeta.get(agentId) : null) || {};
      // Skip no-op patches: activity updates stream in at a high rate and an
      // unchanged patch would still mint a new Map + state, forcing a full
      // re-render of the Ink tree.
      if (patchKeys.every((key) => stableJson(current[key]) === stableJson(patch[key]))) {
        return state;
      }
      const meta = new Map(state.activeAgentMeta instanceof Map ? state.activeAgentMeta : []);
      meta.set(agentId, { ...current, ...patch });
      return { ...state, activeAgentMeta: meta };
    }
    case "agents/select":
      return {
        ...state,
        selectedAgentIndex: action.index,
        agentSelectionMode: action.index >= 0,
      };
    case "agents/cycle": {
      if (state.agents.length === 0) return state;
      const cur = state.selectedAgentIndex < 0 ? 0 : state.selectedAgentIndex;
      const next = action.direction === "left"
        ? Math.max(0, cur - 1)
        : Math.min(state.agents.length - 1, cur + 1);
      return { ...state, selectedAgentIndex: next, agentSelectionMode: true };
    }
    case "agents/clearTarget":
      return { ...state, selectedAgentIndex: -1, agentSelectionMode: false };
    case "agents/window":
      return { ...state, agentListWindowStart: action.windowStart };
    case "projects/set": {
      const list = Array.isArray(action.list) ? action.list : [];
      const previousSelectedRoot = state.selectedProjectRoot
        || projectRootOf(state.projects[state.selectedProjectIndex]);
      const selectedRoot = String(action.selectedProjectRoot || previousSelectedRoot || "");
      const selectedIndex = selectedRoot
        ? list.findIndex((row) => projectRootOf(row) === selectedRoot)
        : -1;
      const nextActiveRoot = action.activeProjectRoot || state.activeProjectRoot;
      if (
        listPayloadEqual(state.projects, list) &&
        state.selectedProjectRoot === (selectedIndex >= 0 ? selectedRoot : "") &&
        state.selectedProjectIndex === selectedIndex &&
        state.activeProjectRoot === nextActiveRoot &&
        state.emptyProjectsDownArmed === (list.length === 0 ? state.emptyProjectsDownArmed : false)
      ) {
        return state;
      }
      return {
        ...state,
        projects: list,
        selectedProjectRoot: selectedIndex >= 0 ? selectedRoot : "",
        selectedProjectIndex: selectedIndex,
        activeProjectRoot: nextActiveRoot,
        emptyProjectsDownArmed: list.length === 0 ? state.emptyProjectsDownArmed : false,
      };
    }
    case "projects/select":
      return {
        ...state,
        selectedProjectIndex: action.index,
        selectedProjectRoot: String(action.projectRoot || projectRootOf(state.projects[action.index]) || ""),
        emptyProjectsDownArmed: false,
      };
    case "projects/clearSelection":
      return { ...state, selectedProjectIndex: -1, selectedProjectRoot: "", emptyProjectsDownArmed: false };
    case "projects/armEmptyDown":
      return { ...state, emptyProjectsDownArmed: true };
    case "projects/window":
      return { ...state, projectListWindowStart: Math.max(0, action.windowStart | 0) };
    case "scope/set":
      return { ...state, globalScope: action.scope === "project" ? "project" : "controller" };
    case "status/set": {
      const nextStatus = { ...state.status, ...action.payload };
      if (statusPayloadEqual(state.status, nextStatus)) return state;
      return { ...state, status: nextStatus };
    }
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
    case "settings/applyMode": {
      const mode = state.modeOptions[state.selectedModeIndex] || state.settings.launchMode;
      return { ...state, settings: { ...state.settings, launchMode: mode } };
    }
    case "settings/applyProvider": {
      const selected = state.providerOptions[state.selectedProviderIndex];
      const agentProvider = selected && selected.value ? selected.value : state.settings.agentProvider;
      return { ...state, settings: { ...state.settings, agentProvider } };
    }
    case "modeIndex/set":
      return { ...state, selectedModeIndex: Math.max(0, action.index | 0) };
    case "providerIndex/set":
      return { ...state, selectedProviderIndex: Math.max(0, action.index | 0) };
    case "cronIndex/set":
      return { ...state, selectedCronIndex: Math.max(-1, action.index | 0) };
    case "cron/set": {
      const list = Array.isArray(action.list) ? action.list : [];
      if (listPayloadEqual(state.cronTasks, list)) return state;
      return { ...state, cronTasks: list };
    }
    case "loop/set": {
      const summary = action.summary && typeof action.summary === "object" ? action.summary : null;
      if (stableJson(state.loopSummary) === stableJson(summary)) return state;
      return { ...state, loopSummary: summary };
    }
    case "stream/begin":
      return {
        ...state,
        activeStream: { publisher: action.publisher || "", chunks: [] },
      };
    case "stream/delta": {
      const delta = String(action.delta || "");
      if (!state.activeStream) {
        return {
          ...state,
          activeStream: { publisher: action.publisher || "", chunks: [delta] },
        };
      }
      const chunks = Array.isArray(state.activeStream.chunks)
        ? state.activeStream.chunks
        : [String(state.activeStream.text || "")];
      return {
        ...state,
        activeStream: {
          ...state.activeStream,
          chunks: chunks.concat([delta]),
        },
      };
    }
    case "stream/end": {
      if (!state.activeStream) return state;
      const lines = activeStreamText(state.activeStream).split(/\r?\n/);
      const prefix = state.activeStream.publisher
        ? `${state.activeStream.publisher}: `
        : "";
      const annotated = prefix && lines.length > 0
        ? [`${prefix}${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)]
        : lines;
      const next = appendLog(state, annotated.map((text) => ({
        text,
        type: "bus",
        sourceType: "bus",
      })));
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

module.exports = { reducer, createInitialState, DASHBOARD_VIEWS, activeStreamText };
