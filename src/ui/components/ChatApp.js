"use strict";

/**
 * Ink-based chat TUI. Behaviourally equivalent to runChatBlessed in
 * src/chat/index.js but rendered via React + ink.
 *
 * Activation: set UFOO_TUI=ink. The blessed path remains the default; flip
 * the switch in src/chat/index.js once P3 is signed off.
 *
 * Coverage today: layout shell + dashboard bar (5 modes: projects, agents,
 * mode, provider, resume, cron) + multiline editor + status line +
 * Tab/Esc focus + agent selection + Up/Down history. Daemon connection,
 * command execution, completion and the internal-agent view land in
 * later P3 sub-tasks (3.5, 3.6).
 *
 * Chat state is kept in chatReducer.js so the entire transition table can
 * be exercised by jest without mounting ink.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { runInk } = require("../runInk");
const fmt = require("../format");
const { createMultilineInput } = require("./MultilineInput");
const { createDashboardBar } = require("./DashboardBar");
const { reducer, createInitialState } = require("./chatReducer");

function bootstrapEnvironment(projectRoot, options = {}) {
  // Mirror of the early section of runChatBlessed: ensure ufoo dirs exist
  // and that we have a stable subscriber ID. We deliberately keep the
  // non-UI side-effects in their own helper so unit tests can assert on
  // them without importing ink.
  const { canonicalProjectRoot } = require("../../projects");
  const { getUfooPaths } = require("../../ufoo/paths");
  const UfooInit = require("../../init");
  const { isRunning } = require("../../daemon");
  const { startDaemon } = require("../../chat/transport");

  const globalMode = options && options.globalMode === true;
  let activeProjectRoot = projectRoot;
  try {
    activeProjectRoot = canonicalProjectRoot(projectRoot);
  } catch {
    activeProjectRoot = path.resolve(projectRoot || process.cwd());
  }

  const runtimePaths = getUfooPaths(projectRoot);
  const contextIndexFile = path.join(runtimePaths.ufooDir, "context", "decisions.jsonl");
  const needsBootstrap = globalMode && (
    !fs.existsSync(runtimePaths.ufooDir)
    || !fs.existsSync(runtimePaths.busDir)
    || !fs.existsSync(runtimePaths.agentDir)
    || !fs.existsSync(contextIndexFile)
  );

  return {
    activeProjectRoot,
    globalMode,
    runtimePaths,
    needsBootstrap,
    UfooInit,
    isRunning,
    startDaemon,
  };
}

async function ensureSubscriberId(projectRoot) {
  if (process.env.UFOO_SUBSCRIBER_ID) return;
  const { getUfooPaths } = require("../../ufoo/paths");
  const sessionFile = path.join(getUfooPaths(projectRoot).ufooDir, "chat", "session-id.txt");
  const sessionDir = path.dirname(sessionFile);
  fs.mkdirSync(sessionDir, { recursive: true });
  let sessionId;
  if (fs.existsSync(sessionFile)) {
    sessionId = fs.readFileSync(sessionFile, "utf8").trim();
  } else {
    sessionId = crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(sessionFile, sessionId, "utf8");
  }
  process.env.UFOO_SUBSCRIBER_ID = `claude-code:${sessionId}`;
}

function inputHistoryFilePath(projectRoot, options = {}) {
  const { getUfooPaths } = require("../../ufoo/paths");
  const { globalMode } = options || {};
  if (globalMode) {
    const os = require("os");
    const globalChatRoot = path.join(os.homedir(), ".ufoo", "chat");
    const globalDir = path.join(globalChatRoot, "global-input-history");
    const projectId = projectRootToId(projectRoot);
    return path.join(globalDir, `${projectId}.jsonl`);
  }
  return path.join(getUfooPaths(projectRoot || process.cwd()).ufooDir, "chat", "input-history.jsonl");
}

function chatHistoryFilePath(projectRoot, options = {}) {
  const { getUfooPaths } = require("../../ufoo/paths");
  const { globalMode } = options || {};
  if (globalMode) {
    const os = require("os");
    const globalChatRoot = path.join(os.homedir(), ".ufoo", "chat");
    const globalDir = path.join(globalChatRoot, "global-history");
    const projectId = projectRootToId(projectRoot);
    return path.join(globalDir, `${projectId}.jsonl`);
  }
  return path.join(getUfooPaths(projectRoot || process.cwd()).ufooDir, "chat", "history.jsonl");
}

function projectRootToId(projectRoot) {
  try {
    const { buildProjectId } = require("../../projects");
    return buildProjectId(projectRoot || process.cwd());
  } catch {
    return crypto.createHash("sha256").update(String(projectRoot || "")).digest("hex").slice(0, 16);
  }
}

function loadChatHistory(projectRoot, cap = 200, options = {}) {
  const file = chatHistoryFilePath(projectRoot, options);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry) continue;
        if (entry.type === "spacer") {
          out.push("");
          continue;
        }
        const text = String(entry.text || "");
        if (!text) continue;
        // Strip blessed-tag markup that the legacy log writer used; ink
        // can't render those tags and we don't want them shown literally.
        const stripped = text.replace(/\{[^{}]+\}/g, "");
        out.push(stripped);
      } catch {
        // ignore malformed lines
      }
    }
    return out.slice(-cap);
  } catch {
    return [];
  }
}

function loadInputHistory(projectRoot, cap = 200, options = {}) {
  const file = inputHistoryFilePath(projectRoot, options);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const value = String((obj && obj.value) || "").trim();
        if (value) out.push(value);
      } catch {
        // ignore malformed entries
      }
    }
    return out.slice(-cap);
  } catch {
    return [];
  }
}

function appendInputHistory(projectRoot, value, options = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return;
  const file = inputHistoryFilePath(projectRoot, options);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ value: trimmed, ts: Date.now() })}\n`);
  } catch {
    // best-effort persistence; failure is not user-visible
  }
}

function getAgentLabelFor(meta, agentId) {
  if (meta && meta.nickname) return meta.nickname;
  if (!agentId) return "";
  const colon = agentId.indexOf(":");
  if (colon < 0) return agentId;
  const head = agentId.slice(0, colon);
  const tail = agentId.slice(colon + 1).slice(0, 6);
  return tail ? `${head}:${tail}` : head;
}

const CHAT_BANNER_LINES = [
  "█ █ █▀▀ █▀█ █▀▄   █▀▀ █ █ ▄▀█ ▀█▀",
  "█ █ █   █ █ █ █   █   █▀█ █▀█  █ ",
  "▀▀▀ ▀▀▀ ▀▀▀ ▀▀    ▀▀▀ ▀ ▀ ▀ ▀  ▀ ",
];

function buildChatBannerLines(props, version) {
  const os = require("os");
  const home = os.homedir();
  const root = props.activeProjectRoot || process.cwd();
  const shortRoot = root.startsWith(home) ? root.replace(home, "~") : root;
  const modeLabel = props.globalMode
    ? `global (${props.globalScope || "controller"})`
    : "project";
  const padding = " ".repeat(
    CHAT_BANNER_LINES.reduce((max, line) => Math.max(max, line.length), 0)
  );
  const info = [
    `Version: ${version}`,
    `Mode: ${modeLabel}`,
    `Dictionary: ${shortRoot}`,
  ];
  const rows = Math.max(CHAT_BANNER_LINES.length, info.length);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const left = CHAT_BANNER_LINES[i] || padding;
    const right = info[i] || "";
    out.push(`  ${left}  ${right}`);
  }
  return out;
}

function createChatApp({ React, ink, props, interactive = true }) {
  const { useReducer, useEffect, useState, useCallback, useRef } = React;
  const { Box, Text, Static, useInput, useApp, useStdout } = ink;
  const h = React.createElement;
  const MultilineInput = createMultilineInput({ React, ink });
  const DashboardBar = createDashboardBar({ React, ink });

  // Build the initial log: chat history if there is any, otherwise an
  // ASCII banner with project / mode / version info. We resolve history
  // synchronously here so the very first paint already shows it instead
  // of rendering an empty banner and then flashing in the lines.
  const versionLabel = String(fmt.UCODE_VERSION || "");
  const banner = buildChatBannerLines(props, versionLabel);
  const persistedHistory = loadChatHistory(props.projectRoot, 200, { globalMode: props.globalMode });
  const initialLogText = persistedHistory.length > 0
    ? banner.concat(["", "─── history ───"]).concat(persistedHistory).concat([""])
    : banner.concat([""]);

  return function ChatApp() {
    const [state, dispatch] = useReducer(
      reducer,
      undefined,
      () => createInitialState({
        banner: initialLogText,
        globalMode: props.globalMode,
        globalScope: props.globalScope || "controller",
      })
    );
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const [spinnerTick, setSpinnerTick] = useState(0);
    const { exit } = useApp();
    const { stdout } = useStdout();

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () =>
        setSize({ cols: stdout.columns || 0, rows: stdout.rows || 0 });
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    // Load persisted input history once on mount.
    useEffect(() => {
      try {
        const history = loadInputHistory(props.projectRoot, 200, { globalMode: props.globalMode });
        if (history.length > 0) dispatch({ type: "history/load", list: history });
      } catch { /* ignore */ }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Wire daemon: register a message handler that turns IPC responses
    // into reducer dispatches, then kick off connect(). On unmount we
    // close the connection so the next ink mount can attach cleanly.
    useEffect(() => {
      if (!interactive) return undefined;
      const conn = props.daemonConnection;
      const setHandler = props.setDaemonMessageHandler;
      if (!conn || typeof conn.connect !== "function" || typeof setHandler !== "function") {
        return undefined;
      }
      const { IPC_RESPONSE_TYPES } = require("../../shared/eventContract");
      setHandler((msg) => {
        if (!msg || typeof msg !== "object") return;
        const type = msg.type;
        if (type === IPC_RESPONSE_TYPES.RESPONSE) {
          const text = String(msg.text || msg.summary || "").trim();
          if (text) dispatch({ type: "log/appendMany", lines: text.split(/\r?\n/) });
          dispatch({ type: "status/idle" });
        } else if (type === IPC_RESPONSE_TYPES.ERROR) {
          dispatch({ type: "log/append", text: `Error: ${msg.error || "unknown error"}` });
          dispatch({ type: "status/idle" });
        } else if (type === IPC_RESPONSE_TYPES.STATUS) {
          // Daemon STATUS arrives as { type: "status", data: { active, active_meta, cron, ... } }.
          // active_meta entries are keyed by `meta.id` (the part after the
          // colon), and the display name lives in display_nickname /
          // nickname rather than a top-level field. Reuse buildAgentMaps
          // from src/chat/agentDirectory so the lookup matches blessed
          // exactly.
          const data = (msg && msg.data) || {};
          const activeIds = Array.isArray(data.active) ? data.active : [];
          const metaList = Array.isArray(data.active_meta) ? data.active_meta : [];
          const { buildAgentMaps } = require("../../chat/agentDirectory");
          const { labelMap, metaMap } = buildAgentMaps(activeIds, metaList);
          const agentsForDispatch = activeIds.map((id) => {
            const meta = metaMap.get(id) || {};
            const colon = id.indexOf(":");
            const fallbackType = colon > 0 ? id.slice(0, colon) : id;
            const fallbackId = colon > 0 ? id.slice(colon + 1) : "";
            return {
              fullId: id,
              type: meta.type || fallbackType,
              id: meta.id || fallbackId,
              nickname: labelMap.get(id) || id,
            };
          });
          dispatch({ type: "agents/set", list: agentsForDispatch });
          if (data.cron && Array.isArray(data.cron.tasks)) {
            dispatch({ type: "cron/set", list: data.cron.tasks });
          }
        } else if (type === IPC_RESPONSE_TYPES.BUS) {
          // Bus messages can be plain delivery confirmations or streaming
          // payloads. The streaming format is a JSON envelope inside the
          // `message` string with { stream: true, delta, done, reason };
          // see daemonMessageRouter.normalizeDisplayMessage.
          const data = (msg && msg.data) || {};
          const publisher = data.publisher || "bus";
          const rawMessage = String(data.message || "");
          let streamPayload = null;
          if (rawMessage && rawMessage.charAt(0) === "{") {
            try {
              const parsed = JSON.parse(rawMessage);
              if (parsed && typeof parsed === "object" && parsed.stream) streamPayload = parsed;
            } catch { /* fall through to plain text */ }
          }
          if (streamPayload) {
            const delta = String(streamPayload.delta || "");
            if (delta) dispatch({ type: "stream/delta", publisher, delta });
            if (streamPayload.done) dispatch({ type: "stream/end" });
            return;
          }
          if (rawMessage) {
            dispatch({ type: "log/appendMany", lines: rawMessage.split(/\r?\n/) });
          }
        } else if (type === IPC_RESPONSE_TYPES.BUS_SEND_OK) {
          dispatch({ type: "log/append", text: `✓ Message delivered` });
          dispatch({ type: "status/idle" });
        }
      });
      conn.connect();
      return () => {
        try { if (typeof conn.close === "function") conn.close(); } catch { /* ignore */ }
      };
    }, [interactive]);

    // commandExecutor wiring. The blessed implementation reuses this
    // module to dispatch every slash command (~30 callbacks). We adapt
    // the callback surface to ink: log/status/render writes go through
    // dispatch, daemon ops go through props.daemonConnection, and
    // blessed-tag markup the executor sprinkles into log lines is
    // stripped before rendering.
    const commandExecutorRef = useRef(null);
    useEffect(() => {
      if (!interactive) return undefined;
      const { createCommandExecutor } = require("../../chat/commandExecutor");
      const { parseCommand: parseCmd } = require("../../chat/commands");
      const { stripBlessedTags } = require("../../chat/text");
      const conn = props.daemonConnection;
      const tport = props.daemonTransport;

      const safeLog = (kind, text) => {
        const cleaned = stripBlessedTags(String(text || ""));
        if (!cleaned) return;
        const lines = cleaned.split(/\r?\n/);
        if (kind === "error") {
          dispatch({ type: "log/append", text: `Error: ${lines[0] || ""}` });
          for (const line of lines.slice(1)) dispatch({ type: "log/append", text: line });
        } else {
          dispatch({ type: "log/appendMany", lines });
        }
      };

      try {
        commandExecutorRef.current = createCommandExecutor({
          projectRoot: props.projectRoot,
          getActiveProjectRoot: () => props.activeProjectRoot || props.projectRoot,
          parseCommand: parseCmd,
          escapeBlessed: (v) => String(v == null ? "" : v),
          logMessage: safeLog,
          resolveStatusLine: () => dispatch({ type: "status/idle" }),
          renderScreen: () => {},
          getActiveAgents: () => state.agents,
          getActiveAgentMetaMap: () => state.activeAgentMeta,
          getAgentLabel: (id) => getAgentLabelFor(state.activeAgentMeta.get(id), id),
          isDaemonRunning: () => props.env && props.env.isRunning ? props.env.isRunning(props.projectRoot) : true,
          startDaemon: () => props.env && props.env.startDaemon && props.env.startDaemon(props.projectRoot),
          stopDaemon: () => {},
          restartDaemon: async () => {
            try { if (conn && typeof conn.close === "function") conn.close(); } catch { /* ignore */ }
            try { if (typeof conn.connect === "function") conn.connect(); } catch { /* ignore */ }
          },
          send: (req) => { try { if (conn && typeof conn.send === "function") conn.send(req); } catch { /* ignore */ } },
          requestStatus: () => {
            try {
              const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
              if (conn && typeof conn.send === "function") conn.send({ type: IPC_REQUEST_TYPES.STATUS });
            } catch { /* ignore */ }
          },
          globalMode: Boolean(props.globalMode),
          listProjects: () => state.projects,
          getCurrentProject: () => ({ projectRoot: props.projectRoot }),
          switchProject: async (target) => {
            if (props.daemonCoordinator && typeof props.daemonCoordinator.switchProject === "function") {
              try {
                return await props.daemonCoordinator.switchProject(target || {});
              } catch (err) {
                return { ok: false, error: err && err.message ? err.message : "switch failed" };
              }
            }
            return { ok: false, error: "daemon coordinator unavailable" };
          },
        });
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: command executor unavailable (${err && err.message ? err.message : err})` });
      }
      return undefined;
      // We deliberately depend only on `interactive`; the executor reads
      // dynamic state (agents, projects) through closures that close over
      // `state`. React re-renders the component every state change, so
      // those closures see fresh values without needing to recreate the
      // executor.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interactive]);

    // Periodic STATUS poll to keep the agents footer fresh, mirroring
    // blessed's requestStatus on a timer.
    useEffect(() => {
      if (!interactive) return undefined;
      const conn = props.daemonConnection;
      if (!conn || typeof conn.send !== "function") return undefined;
      const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
      const tick = () => {
        try { conn.send({ type: IPC_REQUEST_TYPES.STATUS }); } catch { /* ignore */ }
      };
      tick();
      const timer = setInterval(tick, 3000);
      return () => clearInterval(timer);
    }, [interactive]);

    // Refresh the project rail in global mode. blessed pulls this off the
    // local registry; we do the same so the dashboard's first row tracks
    // every running project without needing a daemon round-trip.
    useEffect(() => {
      if (!interactive || !props.globalMode) return undefined;
      const refresh = () => {
        try {
          const { listProjectRuntimes } = require("../../projects");
          const rows = listProjectRuntimes({ validate: true, cleanupTmp: true }) || [];
          const list = rows.map((row) => ({
            id: row.project_id || row.project_root || "",
            label: row.project_name || (row.project_root ? require("path").basename(row.project_root) : ""),
            root: row.project_root || "",
            status: row.status || "",
            active: row.project_root === props.activeProjectRoot,
          }));
          dispatch({
            type: "projects/set",
            list,
            activeProjectRoot: props.activeProjectRoot,
          });
        } catch { /* ignore */ }
      };
      refresh();
      const timer = setInterval(refresh, 4000);
      return () => clearInterval(timer);
    }, [interactive, props.globalMode]);

    useEffect(() => {
      if (!state.status.message || state.status.type === "none") return undefined;
      const timer = setInterval(() => setSpinnerTick((t) => t + 1), 100);
      return () => clearInterval(timer);
    }, [state.status.message, state.status.type]);

    const targetAgentId = state.agentSelectionMode && state.selectedAgentIndex >= 0
      ? state.agents[state.selectedAgentIndex]
      : null;
    const targetAgentMeta = targetAgentId ? state.activeAgentMeta.get(targetAgentId) : null;
    const targetAgentLabel = targetAgentId ? getAgentLabelFor(targetAgentMeta, targetAgentId) : "";

    const submit = useCallback((submitted) => {
      const value = String(submitted == null ? state.draft : submitted);
      const trimmed = value.trim();
      if (!trimmed) return;
      dispatch({ type: "draft/clear" });
      dispatch({ type: "history/push", value: trimmed });
      try { appendInputHistory(props.projectRoot, trimmed, { globalMode: props.globalMode }); } catch { /* ignore */ }
      dispatch({ type: "log/append", text: targetAgentLabel ? `›@${targetAgentLabel} ${trimmed}` : `› ${trimmed}` });

      // Slash commands route through the shared commandExecutor. The
      // executor pulls in /cron, /group, /role, /solo, /settings,
      // /doctor, /init, /launch, /project, /open, /help, /skills, etc.
      if (trimmed.startsWith("/")) {
        const exec = commandExecutorRef.current;
        if (!exec || typeof exec.executeCommand !== "function") {
          dispatch({ type: "log/append", text: "Error: command executor not ready yet" });
          return;
        }
        try {
          const maybe = exec.executeCommand(trimmed);
          if (maybe && typeof maybe.then === "function") {
            maybe.catch((err) => {
              dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
            });
          }
        } catch (err) {
          dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
        }
        return;
      }

      if (!props.daemonConnection || typeof props.daemonConnection.send !== "function") {
        dispatch({ type: "log/append", text: "Error: daemon connection unavailable" });
        return;
      }
      const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
      try {
        if (targetAgentId) {
          props.daemonConnection.send({
            type: IPC_REQUEST_TYPES.BUS_SEND,
            target: targetAgentId,
            text: trimmed,
          });
          dispatch({ type: "agents/clearTarget" });
          dispatch({
            type: "status/set",
            payload: { message: "Sending message...", type: "typing", showTimer: false, startedAt: Date.now() },
          });
        } else {
          props.daemonConnection.send({
            type: IPC_REQUEST_TYPES.PROMPT,
            prompt: trimmed,
          });
          dispatch({
            type: "status/set",
            payload: { message: "Working on task...", type: "thinking", showTimer: true, startedAt: Date.now() },
          });
        }
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : "send failed"}` });
        dispatch({ type: "status/idle" });
      }
    }, [state.draft, targetAgentLabel, targetAgentId]);

    const onArrowUpAtTop = useCallback(() => {
      if (state.inputHistory.length > 0) {
        const next = Math.max(0, state.historyIndex - 1);
        if (next !== state.historyIndex || state.draft !== state.inputHistory[next]) {
          dispatch({ type: "history/setIndex", index: next });
          dispatch({ type: "draft/set", value: state.inputHistory[next] || "" });
          return;
        }
      }
      if (state.agentSelectionMode) dispatch({ type: "agents/clearTarget" });
    }, [state.inputHistory, state.historyIndex, state.draft, state.agentSelectionMode]);

    const onArrowDownAtBottom = useCallback((currentValue) => {
      if (state.inputHistory.length > 0) {
        const transition = fmt.resolveHistoryDownTransition({
          inputHistory: state.inputHistory,
          historyIndex: state.historyIndex,
          currentValue,
        });
        if (transition.moved) {
          dispatch({ type: "history/setIndex", index: transition.nextHistoryIndex });
          dispatch({ type: "draft/set", value: transition.nextValue });
          return;
        }
      }
      // Hand focus to the dashboard. Three-tier flow:
      //   global mode  → projects → agents → mode/provider/cron
      //   project mode → agents → mode/provider/cron
      if (props.globalMode && state.projects.length > 0) {
        dispatch({ type: "focus/set", mode: "dashboard" });
        dispatch({ type: "view/set", view: "projects" });
        if (state.selectedProjectIndex < 0) {
          dispatch({ type: "projects/select", index: 0 });
          dispatch({ type: "projects/window", windowStart: 0 });
        }
        return;
      }
      dispatch({ type: "focus/set", mode: "dashboard" });
      dispatch({ type: "view/set", view: "agents" });
      if (state.agents.length > 0 && state.selectedAgentIndex < 0) {
        dispatch({ type: "agents/select", index: 0 });
      }
    }, [state.inputHistory, state.historyIndex, state.projects.length, state.selectedProjectIndex, state.agents.length, state.selectedAgentIndex, props.globalMode]);

    const onArrowSideAtEmpty = useCallback((direction) => {
      if (!state.agentSelectionMode || state.agents.length === 0) return;
      dispatch({ type: "agents/cycle", direction });
    }, [state.agentSelectionMode, state.agents.length]);

    // Inline completions: shown above the input whenever the draft starts
    // with "/" or "@". Tab/Enter accept the highlighted entry, ↑↓ move the
    // selection. The list reuses the pure buildCompletions helper from
    // src/ui/format so jest can pin the source list without rendering ink.
    const { COMMAND_REGISTRY, COMMAND_TREE } = require("../../chat/commands");
    const agentLabels = state.agents.map((id) =>
      getAgentLabelFor(state.activeAgentMeta.get(id), id)
    );

    // Lazy-load the dynamic completion sources once so /group run and
    // /solo run get the same alias/profile suggestions blessed shows.
    const dynamicSourcesRef = useRef(null);
    if (!dynamicSourcesRef.current) {
      const sources = { groupTemplates: [], soloProfiles: [] };
      try {
        const { loadTemplateRegistry } = require("../../group/templates");
        const reg = typeof loadTemplateRegistry === "function" ? loadTemplateRegistry(props.projectRoot) : null;
        if (reg && Array.isArray(reg.templates)) {
          sources.groupTemplates = reg.templates.map((item) => ({
            alias: item.alias,
            cmd: item.alias,
            desc: item.templateDescription || "",
            source: item.source || "",
          }));
        }
      } catch { /* ignore */ }
      try {
        const { loadPromptProfileRegistry } = require("../../group/promptProfiles");
        const { buildPromptProfileCandidates } = require("../../solo/commands");
        const reg = typeof loadPromptProfileRegistry === "function" ? loadPromptProfileRegistry(props.projectRoot) : null;
        if (reg && typeof buildPromptProfileCandidates === "function") {
          sources.soloProfiles = buildPromptProfileCandidates(reg) || [];
        }
      } catch { /* ignore */ }
      dynamicSourcesRef.current = sources;
    }

    const completions = fmt.buildCompletions({
      text: state.draft,
      agents: state.agents,
      agentLabels,
      commands: COMMAND_REGISTRY,
      commandTree: COMMAND_TREE,
      groupTemplates: dynamicSourcesRef.current.groupTemplates,
      soloProfiles: dynamicSourcesRef.current.soloProfiles,
      limit: 20,
    });
    const [completionIndex, setCompletionIndex] = useState(0);
    // First visible row inside the popup. We show 8 rows at a time
    // (POPUP_PAGE_SIZE) and slide the window when the cursor crosses
    // the bottom or top, mimicking how a terminal list typically scrolls.
    const POPUP_PAGE_SIZE = 8;
    const [completionWindowStart, setCompletionWindowStart] = useState(0);
    // Bumped whenever the completion popup writes a new value into the
    // draft — MultilineInput watches this counter so it can park its
    // cursor at the end of the freshly accepted suggestion instead of
    // staying wherever the user last typed.
    const [draftVersion, setDraftVersion] = useState(0);
    // Reset the selection cursor whenever the suggestion list shape changes.
    useEffect(() => {
      if (completions.length === 0) {
        if (completionIndex !== 0) setCompletionIndex(0);
        if (completionWindowStart !== 0) setCompletionWindowStart(0);
      } else if (completionIndex >= completions.length) {
        setCompletionIndex(completions.length - 1);
        setCompletionWindowStart(Math.max(0, completions.length - POPUP_PAGE_SIZE));
      }
    }, [completions.length, completionIndex, completionWindowStart]);
    const completionsOpen = completions.length > 0;
    const acceptCompletion = useCallback(() => {
      if (!completionsOpen) return false;
      const item = completions[Math.max(0, Math.min(completions.length - 1, completionIndex))];
      if (item) {
        dispatch({ type: "draft/set", value: item.replace });
        setDraftVersion((v) => v + 1);
      }
      setCompletionIndex(0);
      return true;
    }, [completionsOpen, completions, completionIndex]);

    useInput((input, key) => {
      if (key.ctrl && input === "c") { exit(); return; }
      if (key.ctrl && input === "o") { dispatch({ type: "merge/expand" }); return; }

      // Completion popup steals arrow/Enter/Esc/Tab while it's open. The
      // user types to filter, picks with the cursor and accepts with Tab
      // or Enter; Esc dismisses by clearing the trigger character.
      if (completionsOpen) {
        if (key.upArrow) {
          setCompletionIndex((i) => {
            const next = (i - 1 + completions.length) % completions.length;
            setCompletionWindowStart((ws) => {
              if (next < ws) return next;
              if (next === completions.length - 1) {
                // wrapped to the bottom — snap window to the tail.
                return Math.max(0, completions.length - POPUP_PAGE_SIZE);
              }
              return ws;
            });
            return next;
          });
          return;
        }
        if (key.downArrow) {
          setCompletionIndex((i) => {
            const next = (i + 1) % completions.length;
            setCompletionWindowStart((ws) => {
              if (next === 0) return 0; // wrapped to the head
              if (next >= ws + POPUP_PAGE_SIZE) return next - POPUP_PAGE_SIZE + 1;
              return ws;
            });
            return next;
          });
          return;
        }
        if (key.return || key.tab) { acceptCompletion(); return; }
        if (key.escape) { dispatch({ type: "draft/clear" }); return; }
      }

      if (key.tab) { dispatch({ type: "focus/toggle" }); return; }
      // Dashboard focus + agents view + agent selected + Enter: hand off
      // to the raw PTY mirror via the runChatInk loop.
      if (key.return && state.focusMode === "dashboard"
          && state.dashboardView === "agents"
          && state.agentSelectionMode
          && state.selectedAgentIndex >= 0) {
        const agentId = state.agents[state.selectedAgentIndex];
        if (agentId && typeof props.requestEnterAgentView === "function") {
          props.requestEnterAgentView(agentId);
          exit();
        }
        return;
      }
      // Dashboard focus + projects view: ←/→ moves the highlighted
      // project, Enter switches the daemon connection to that project,
      // Ctrl+X stops it.
      if (state.focusMode === "dashboard" && state.dashboardView === "projects" && state.projects.length > 0) {
        if (key.leftArrow || key.rightArrow) {
          const dir = key.leftArrow ? -1 : 1;
          const cur = Number.isFinite(state.selectedProjectIndex) && state.selectedProjectIndex >= 0
            ? state.selectedProjectIndex : 0;
          const next = (cur + dir + state.projects.length) % state.projects.length;
          dispatch({ type: "projects/select", index: next });
          // Slide the visible window to keep the cursor on screen. We mirror
          // clampAgentWindowWithSelection's logic with maxProjectWindow=5.
          const max = Math.max(1, Math.min(5, state.projects.length));
          let nextStart = state.projectListWindowStart || 0;
          if (next < nextStart) nextStart = next;
          else if (next >= nextStart + max) nextStart = next - max + 1;
          if (cur === state.projects.length - 1 && next === 0) nextStart = 0;
          if (cur === 0 && next === state.projects.length - 1) {
            nextStart = Math.max(0, state.projects.length - max);
          }
          if (nextStart !== state.projectListWindowStart) {
            dispatch({ type: "projects/window", windowStart: nextStart });
          }

          // Switching projects with ←/→ also loads that project's chat
          // log + delegates the daemon connection. Refresh STATUS so the
          // agents footer redraws once the daemon catches up.
          const proj = state.projects[next];
          const target = proj && (proj.root || proj.id);
          if (target && !proj.active) {
            dispatch({ type: "log/clear" });
            const banner = buildChatBannerLines({
              ...props,
              activeProjectRoot: target,
            }, fmt.UCODE_VERSION || "");
            dispatch({ type: "log/appendMany", lines: banner });
            const persisted = loadChatHistory(target, 200, { globalMode: props.globalMode });
            if (persisted.length > 0) {
              dispatch({ type: "log/append", text: "" });
              dispatch({ type: "log/append", text: "─── history ───" });
              dispatch({ type: "log/appendMany", lines: persisted });
            }
            if (props.daemonCoordinator && typeof props.daemonCoordinator.switchProject === "function") {
              const { socketPath } = require("../../daemon");
              Promise.resolve(props.daemonCoordinator.switchProject({
                projectRoot: target,
                sockPath: socketPath(target),
              }))
                .then((res) => {
                  if (res && res.ok === false) {
                    dispatch({ type: "log/append", text: `Error: ${res.error || "switch failed"}` });
                  } else {
                    // Successful switch: enter project scope so the
                    // Agents row reappears below the projects rail.
                    dispatch({ type: "scope/set", scope: "project" });
                  }
                })
                .catch((err) => dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` }));
            }
          }
          return;
        }
        if (key.return) {
          // ←/→ already handled the switch; Enter on the projects rail
          // just returns focus to the input box.
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (key.ctrl && input === "x") {
          const cur = state.selectedProjectIndex >= 0 ? state.selectedProjectIndex : 0;
          const proj = state.projects[cur];
          const target = proj && (proj.root || proj.id);
          if (!target) return;
          dispatch({ type: "log/append", text: `⚙ Closing ${proj.label || target}...` });
          try {
            const { stopDaemon } = require("../../chat/transport");
            stopDaemon(target);
            dispatch({ type: "log/append", text: `✓ Closed ${proj.label || target}` });
          } catch (err) {
            dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
          }
          return;
        }
        if (key.upArrow) {
          // Up out of projects → toggle back to input.
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (key.downArrow) {
          // Down from projects → agents row stays in dashboard focus.
          dispatch({ type: "view/set", view: "agents" });
          return;
        }
      }

      // Dashboard focus on agents/mode/provider/cron — ↑↓ flip between
      // sibling views, ←/→ pick within the active view, Esc returns to
      // the input. Mirrors the blessed handlers in dashboardKeyController.
      if (state.focusMode === "dashboard"
          && (state.dashboardView === "agents"
              || state.dashboardView === "mode"
              || state.dashboardView === "provider"
              || state.dashboardView === "cron")) {
        if (key.escape) {
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (state.dashboardView === "agents") {
          if (key.leftArrow || key.rightArrow) {
            const dir = key.leftArrow ? "left" : "right";
            if (state.agents.length > 0) {
              dispatch({ type: "agents/cycle", direction: dir });
            }
            return;
          }
          if (key.downArrow) {
            dispatch({ type: "view/set", view: "mode" });
            return;
          }
          if (key.upArrow) {
            if (props.globalMode) dispatch({ type: "view/set", view: "projects" });
            else dispatch({ type: "focus/set", mode: "input" });
            return;
          }
        }
        if (state.dashboardView === "mode") {
          if (key.leftArrow || key.rightArrow) {
            const len = state.modeOptions.length;
            if (len > 0) {
              const cur = state.selectedModeIndex;
              const next = key.leftArrow
                ? (cur - 1 + len) % len
                : (cur + 1) % len;
              dispatch({ type: "settings/set", patch: {} });
              dispatch({ type: "view/set", view: "mode" });
              // selectedModeIndex isn't tracked in reducer yet; we keep
              // the value via a dedicated action below.
              dispatch({ type: "modeIndex/set", index: next });
            }
            return;
          }
          if (key.downArrow) { dispatch({ type: "view/set", view: "provider" }); return; }
          if (key.upArrow) { dispatch({ type: "view/set", view: "agents" }); return; }
        }
        if (state.dashboardView === "provider") {
          if (key.leftArrow || key.rightArrow) {
            const len = state.providerOptions.length;
            if (len > 0) {
              const cur = state.selectedProviderIndex;
              const next = key.leftArrow ? (cur - 1 + len) % len : (cur + 1) % len;
              dispatch({ type: "providerIndex/set", index: next });
            }
            return;
          }
          if (key.downArrow) { dispatch({ type: "view/set", view: "cron" }); return; }
          if (key.upArrow) { dispatch({ type: "view/set", view: "mode" }); return; }
        }
        if (state.dashboardView === "cron") {
          if (key.leftArrow || key.rightArrow) {
            const len = state.cronTasks.length;
            if (len > 0) {
              const cur = state.selectedCronIndex < 0 ? 0 : state.selectedCronIndex;
              const next = key.leftArrow ? (cur - 1 + len) % len : (cur + 1) % len;
              dispatch({ type: "cronIndex/set", index: next });
            }
            return;
          }
          if (key.downArrow) { dispatch({ type: "view/set", view: "agents" }); return; }
          if (key.upArrow) { dispatch({ type: "view/set", view: "provider" }); return; }
        }
      }
    }, { isActive: interactive });

    const statusText = computeStatusText(state.status, spinnerTick);
    const inputWidth = Math.max(20, (size.cols || 80) - 4);

    return h(Box, { flexDirection: "column", width: "100%" },
      h(Static, { items: state.logLines }, (item) =>
        h(Text, { key: item.id }, item.text || " ")
      ),
      state.activeMerge ? h(Box, null,
        h(Text, { color: state.activeMerge.entries.some((e) => e.isError) ? "red" : "cyan" },
          fmt.buildToolMergeRowText(state.activeMerge.entries)),
      ) : null,
      state.activeStream ? h(Box, { flexDirection: "column" },
        ...(() => {
          const lines = String(state.activeStream.text || "").split(/\r?\n/);
          const prefix = state.activeStream.publisher
            ? `${state.activeStream.publisher}: `
            : "";
          return lines.map((line, idx) => h(Text, {
            key: `s-${idx}`,
            color: "cyan",
          }, idx === 0 ? `${prefix}${line}` : `  ${line}`));
        })(),
      ) : null,
      h(Box, { marginTop: 1, width: "100%" },
        h(Text, { color: "gray" }, statusText),
        h(Box, { flexGrow: 1 }),
        h(Text, { color: "gray" }, `v${fmt.UCODE_VERSION}`),
      ),
      completionsOpen ? (() => {
        const start = Math.min(completionWindowStart, Math.max(0, completions.length - POPUP_PAGE_SIZE));
        const end = Math.min(completions.length, start + POPUP_PAGE_SIZE);
        const visible = completions.slice(start, end);
        return h(Box, { flexDirection: "column" },
          h(Text, { color: "gray" }, "─".repeat(Math.max(8, size.cols || 80))),
          ...visible.map((s, idxInWindow) => {
            const idx = start + idxInWindow;
            return h(Box, { key: `cmp-${idx}` },
              h(Text, { color: idx === completionIndex ? "cyan" : "gray", inverse: idx === completionIndex }, s.label),
              s.description ? h(Text, { color: "gray" }, `  ${s.description}`) : null,
            );
          }),
        );
      })() : null,
      h(Box, { width: "100%" },
        h(MultilineInput, {
          value: state.draft,
          valueVersion: draftVersion,
          onChange: (next) => dispatch({ type: "draft/set", value: next }),
          onSubmit: (value) => submit(value),
          onCancel: () => {
            // Esc clears the current target if one is locked, otherwise
            // dismisses the in-flight task status. There's no per-request
            // AbortController on daemonConnection (the IPC layer is fire-
            // and-forget), so we clear the spinner so the user knows the
            // UI is responsive again.
            if (state.agentSelectionMode) {
              dispatch({ type: "agents/clearTarget" });
              return;
            }
            if (state.status && state.status.message) {
              dispatch({ type: "status/idle" });
            }
          },
          onArrowUpAtTop,
          onArrowDownAtBottom,
          onArrowLeftAtEmpty: () => onArrowSideAtEmpty("left"),
          onArrowRightAtEmpty: () => onArrowSideAtEmpty("right"),
          width: inputWidth,
          interactive,
          interceptArrowsAndEnter: completionsOpen,
          placeholder: "",
          promptPrefix: targetAgentLabel ? `›@${targetAgentLabel} ` : "› ",
        }),
      ),
      h(DashboardBar, {
        dashboardView: state.dashboardView,
        focusMode: state.focusMode,
        globalMode: state.globalMode,
        globalScope: state.globalScope,
        activeAgents: state.agents,
        activeAgentMeta: state.activeAgentMeta,
        selectedAgentIndex: state.selectedAgentIndex,
        agentListWindowStart: state.agentListWindowStart,
        projectListWindowStart: state.projectListWindowStart,
        maxProjectWindow: 5,
        getAgentLabel: (id, meta) => getAgentLabelFor(meta || state.activeAgentMeta.get(id), id),
        modeOptions: state.modeOptions,
        selectedModeIndex: state.selectedModeIndex,
        providerOptions: state.providerOptions,
        selectedProviderIndex: state.selectedProviderIndex,
        resumeOptions: state.resumeOptions,
        selectedResumeIndex: state.selectedResumeIndex,
        cronTasks: state.cronTasks,
        selectedCronIndex: state.selectedCronIndex,
        projects: state.projects,
        selectedProjectIndex: state.selectedProjectIndex,
        activeProjectRoot: props.activeProjectRoot,
        dashHints: buildDashHints(state, targetAgentLabel),
      }),
    );
  };
}

function buildDashHints(state, targetAgentLabel) {
  void targetAgentLabel; // navigation hint removed by request
  const launchMode = (state.settings && state.settings.launchMode) || "auto";
  const engine = (state.settings && state.settings.agentProvider) || "codex";
  const cronCount = Array.isArray(state.cronTasks) ? state.cronTasks.length : 0;
  // The "Mode / Engine / Cron" suffix is the same compact summary the
  // blessed dashboard surfaces in the bar — it is rendered after the
  // Agents list so users see the project's settings at a glance.
  const agentsHint = `Mode: ${launchMode} · Engine: ${engine} · Cron: ${cronCount}`;
  return {
    agents: agentsHint,
    agentsEmpty: agentsHint,
    mode: "↑↓ switch view · ←→ pick mode",
    provider: "↑↓ switch view · ←→ pick engine",
    resume: "↑↓ switch view · ←→ pick session",
    cron: "↑↓ switch view · ←→ select task",
    projects: "",
  };
}

function computeStatusText(status, spinnerTick) {
  const message = String((status && status.message) || "");
  if (!message) return "CHAT · Ready";
  const type = String((status && status.type) || "thinking");
  const indicators = fmt.STATUS_INDICATORS[type] || fmt.STATUS_INDICATORS.thinking;
  const indicator = indicators[Math.max(0, Math.floor(Number(spinnerTick) || 0)) % indicators.length];
  const startedAt = Number.isFinite(status && status.startedAt) ? status.startedAt : 0;
  const timerText = status && status.showTimer && startedAt
    ? ` (${fmt.formatPendingElapsed(Date.now() - startedAt)}, esc cancel)`
    : "";
  return `${indicator} ${message}${timerText}`;
}

async function runChatInk(projectRoot, options = {}) {
  const env = bootstrapEnvironment(projectRoot, options);

  if (env.needsBootstrap || !fs.existsSync(env.runtimePaths.ufooDir)) {
    const repoRoot = path.join(__dirname, "..", "..", "..");
    const init = new env.UfooInit(repoRoot);
    await init.init({
      modules: "context,bus",
      project: projectRoot,
      controllerMode: env.globalMode,
    });
  }

  await ensureSubscriberId(projectRoot);

  if (!env.isRunning(projectRoot)) {
    env.startDaemon(projectRoot);
  }

  const { socketPath } = require("../../daemon");
  const { connectWithRetry } = require("../../chat/transport");
  const { createDaemonTransport } = require("../../chat/daemonTransport");
  const { createDaemonConnection } = require("../../chat/daemonConnection");
  const { createDaemonCoordinator } = require("../../chat/daemonCoordinator");
  const { startDaemon, stopDaemon } = require("../../chat/transport");
  const { startAgentMirror } = require("./agentMirror");
  const sock = socketPath(projectRoot);
  const daemonTransport = createDaemonTransport({
    projectRoot,
    sockPath: sock,
    isRunning: env.isRunning,
    startDaemon: env.startDaemon,
    connectWithRetry,
  });

  // The connection's `handleMessage` callback is filled in by ChatApp once
  // it mounts and has its dispatcher ready. We expose a setter so the
  // component can wire it without ChatApp needing to construct daemon
  // internals itself.
  let routedMessageHandler = () => {};
  const daemonConnection = createDaemonConnection({
    connectClient: daemonTransport.connectClient.bind(daemonTransport),
    handleMessage: (msg) => routedMessageHandler(msg),
    queueStatusLine: () => {},
    resolveStatusLine: () => {},
    logMessage: () => {},
  });
  const daemonCoordinator = createDaemonCoordinator({
    projectRoot,
    daemonTransport,
    daemonConnection,
    stopDaemon,
    startDaemon,
    logMessage: () => {},
    queueStatusLine: () => {},
    resolveStatusLine: () => {},
  });

  // We loop the ink mount so an "enter agent" request can unmount ink,
  // hand stdout/stdin to the raw PTY mirror, then bring ink back on exit.
  let pendingEnter = null;
  const baseProps = {
    activeProjectRoot: env.activeProjectRoot,
    projectRoot,
    globalMode: env.globalMode,
    globalScope: env.globalMode ? "controller" : "project",
    daemonConnection,
    daemonTransport,
    daemonCoordinator,
    setDaemonMessageHandler: (fn) => { routedMessageHandler = typeof fn === "function" ? fn : () => {}; },
    requestEnterAgentView: (agentId) => { pendingEnter = agentId; },
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    pendingEnter = null;
    const handle = await runInk(
      (React, ink) => {
        const ChatApp = createChatApp({ React, ink, props: baseProps });
        return React.createElement(ChatApp);
      },
      { stdin: process.stdin, stdout: process.stdout, exitOnCtrlC: true }
    );

    // Wait until either the user exits the app or ChatApp asks to enter
    // an agent view. The component triggers the latter by setting
    // pendingEnter and then calling handle.unmount() via its onExit.
    await handle.waitUntilExit();
    if (!pendingEnter) return;

    // Hand stdout/stdin to the mirror. When it exits, loop and re-mount.
    const enteredAgentId = pendingEnter;
    pendingEnter = null;
    await new Promise((resolve) => {
      startAgentMirror({
        agentId: enteredAgentId,
        projectRoot,
        onExit: resolve,
      });
    });
  }
}

module.exports = { runChatInk, createChatApp, bootstrapEnvironment };
