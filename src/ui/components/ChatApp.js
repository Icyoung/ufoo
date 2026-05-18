"use strict";

/**
 * Ink-based chat TUI. Behaviourally equivalent to runChatBlessed in
 * src/chat/index.js but rendered via React + ink.
 *
 * Activation: set UFOO_TUI=ink. The blessed path remains the default; flip
 * the switch in src/chat/index.js once P3 is signed off.
 *
 * Today's coverage: layout shell only — banner, scrolling <Static> log,
 * the ucode MultilineInput, status line. Daemon connection, dashboard
 * views, command execution, completion, history, agent view all come in
 * later P3 sub-tasks (3.4–3.6). The shell exists so we can iterate on
 * layout in real terminals while the heavier wiring lands in stages.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { runInk } = require("../runInk");
const fmt = require("../format");
const { createMultilineInput } = require("./MultilineInput");

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

function createChatApp({ React, ink, props, interactive = true }) {
  const { useState, useCallback, useEffect, useRef } = React;
  const { Box, Text, Static, useInput, useApp } = ink;
  const h = React.createElement;
  const MultilineInput = createMultilineInput({ React, ink });

  const banner = [
    `ufoo chat · ${props.activeProjectRoot}`,
    props.globalMode ? `mode: global (${props.globalScope || "controller"})` : "mode: project",
    "(daemon, dashboard and command execution land in P3.5)",
  ];

  return function ChatApp() {
    const [logLines, setLogLines] = useState(() =>
      banner.concat([""]).map((line, idx) => ({ id: `b-${idx}`, text: line }))
    );
    const [draft, setDraft] = useState("");
    const statusText = "CHAT · Ready (ink shell — P3.3)";
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const lineSeqRef = useRef(banner.length + 1);
    const { exit } = useApp();
    const { useStdout } = ink;
    const { stdout } = useStdout();

    const appendLogLine = useCallback((text) => {
      setLogLines((prev) => {
        const id = `l-${lineSeqRef.current}`;
        lineSeqRef.current += 1;
        const next = prev.concat([{ id, text: String(text || "") }]);
        return next.length > 1000 ? next.slice(-1000) : next;
      });
    }, []);

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () =>
        setSize({ cols: stdout.columns || 0, rows: stdout.rows || 0 });
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    const submit = useCallback((submitted) => {
      const value = String(submitted == null ? draft : submitted).trim();
      if (!value) return;
      setDraft("");
      appendLogLine(`› ${value}`);
      appendLogLine("(daemon not wired yet — P3.5)");
    }, [draft, appendLogLine]);

    useInput((input, key) => {
      if (key.ctrl && input === "c") exit();
    }, { isActive: interactive });

    return h(Box, { flexDirection: "column", width: "100%" },
      h(Static, { items: logLines }, (item) =>
        h(Text, { key: item.id }, item.text || " ")
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: "gray" }, statusText),
      ),
      h(Box, { width: "100%" },
        h(MultilineInput, {
          value: draft,
          onChange: (next) => setDraft(next),
          onSubmit: (value) => submit(value),
          onCancel: () => { /* P3.5: clear pending state, etc. */ },
          width: Math.max(20, (size.cols || 80) - 4),
          interactive,
          placeholder: "type a message...",
        }),
      ),
    );
  };
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

  const props = {
    activeProjectRoot: env.activeProjectRoot,
    globalMode: env.globalMode,
    globalScope: env.globalMode ? "controller" : "project",
  };

  const handle = await runInk(
    (React, ink) => {
      const ChatApp = createChatApp({ React, ink, props });
      return React.createElement(ChatApp);
    },
    { stdin: process.stdin, stdout: process.stdout, exitOnCtrlC: true }
  );
  await handle.waitUntilExit();
}

module.exports = { runChatInk, createChatApp, bootstrapEnvironment };
