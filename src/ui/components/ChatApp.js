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

function getAgentLabelFor(meta, agentId) {
  if (meta && meta.nickname) return meta.nickname;
  if (!agentId) return "";
  const colon = agentId.indexOf(":");
  if (colon < 0) return agentId;
  const head = agentId.slice(0, colon);
  const tail = agentId.slice(colon + 1).slice(0, 6);
  return tail ? `${head}:${tail}` : head;
}

function createChatApp({ React, ink, props, interactive = true }) {
  const { useReducer, useEffect, useState, useCallback } = React;
  const { Box, Text, Static, useInput, useApp, useStdout } = ink;
  const h = React.createElement;
  const MultilineInput = createMultilineInput({ React, ink });
  const DashboardBar = createDashboardBar({ React, ink });

  const banner = [
    `ufoo chat · ${props.activeProjectRoot}`,
    props.globalMode ? `mode: global (${props.globalScope || "controller"})` : "mode: project",
    "(daemon and command execution land in P3.5)",
  ];

  return function ChatApp() {
    const [state, dispatch] = useReducer(
      reducer,
      undefined,
      () => createInitialState({
        banner,
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
          // Status updates carry counts of agents, which we use to
          // refresh the dashboard footer.
          if (Array.isArray(msg.agents)) {
            dispatch({ type: "agents/set", list: msg.agents });
          }
        } else if (type === IPC_RESPONSE_TYPES.BUS) {
          // bus message envelope; render the body so the user sees
          // delivery confirmations.
          const body = String((msg && msg.body) || "").trim();
          if (body) dispatch({ type: "log/appendMany", lines: body.split(/\r?\n/) });
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
      dispatch({ type: "log/append", text: targetAgentLabel ? `›@${targetAgentLabel} ${trimmed}` : `› ${trimmed}` });

      // Slash commands are surfaced for now without going through
      // commandExecutor; full command wiring lands in P3.7. For free-text,
      // bus targeting and PROMPT requests, we hand off to the daemon
      // directly.
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
      if (state.agents.length === 0) return;
      const decision = fmt.resolveAgentSelectionOnDown({
        agentSelectionMode: state.agentSelectionMode,
        selectedAgentIndex: state.selectedAgentIndex,
        totalAgents: state.agents.length,
      });
      if (decision.action === "enter") {
        dispatch({ type: "agents/select", index: decision.index });
      }
    }, [state.inputHistory, state.historyIndex, state.agents, state.agentSelectionMode, state.selectedAgentIndex]);

    const onArrowSideAtEmpty = useCallback((direction) => {
      if (!state.agentSelectionMode || state.agents.length === 0) return;
      dispatch({ type: "agents/cycle", direction });
    }, [state.agentSelectionMode, state.agents.length]);

    useInput((input, key) => {
      if (key.ctrl && input === "c") { exit(); return; }
      if (key.ctrl && input === "o") { dispatch({ type: "merge/expand" }); return; }
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
      h(Box, { marginTop: 1 },
        h(Text, { color: "gray" }, statusText),
      ),
      h(Box, { width: "100%" },
        h(MultilineInput, {
          value: state.draft,
          onChange: (next) => dispatch({ type: "draft/set", value: next }),
          onSubmit: (value) => submit(value),
          onCancel: () => { /* P3.5: cancel pending daemon op */ },
          onArrowUpAtTop,
          onArrowDownAtBottom,
          onArrowLeftAtEmpty: () => onArrowSideAtEmpty("left"),
          onArrowRightAtEmpty: () => onArrowSideAtEmpty("right"),
          width: inputWidth,
          interactive,
          placeholder: targetAgentLabel ? `message @${targetAgentLabel}...` : "type a message...",
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
  const agentsHint = state.agents.length === 0
    ? "No target agents"
    : (targetAgentLabel
        ? `↓ select ${targetAgentLabel} · ←/→ switch · ↑ clear`
        : "↓ select target · ←/→ switch");
  return {
    agents: agentsHint,
    agentsEmpty: agentsHint,
    mode: "↑↓ switch view · ←→ pick mode",
    provider: "↑↓ switch view · ←→ pick agent",
    resume: "↑↓ switch view · ←→ pick session",
    cron: "↑↓ switch view · ←→ select task",
    projects: state.globalMode ? "↑↓ switch view · ←→ pick project · Enter open" : "",
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
