const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawnSync } = require("child_process");
const EventBus = require("../bus");
const { PTY_SOCKET_MESSAGE_TYPES, PTY_SOCKET_SUBSCRIBE_MODES } = require("../shared/ptySocketContract");
const { runInternalRunner } = require("./internalRunner");
const { getUfooPaths } = require("../ufoo/paths");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSubscriberId() {
  if (process.env.UFOO_SUBSCRIBER_ID) {
    const parts = process.env.UFOO_SUBSCRIBER_ID.split(":");
    if (parts.length === 2) {
      return {
        subscriber: process.env.UFOO_SUBSCRIBER_ID,
        agentType: parts[0],
        sessionId: parts[1],
      };
    }
  }
  throw new Error("PTY runner requires UFOO_SUBSCRIBER_ID set by daemon");
}

function safeSubscriber(subscriber) {
  return subscriber.replace(/:/g, "_");
}

function drainQueue(queueFile) {
  if (!fs.existsSync(queueFile)) return [];
  const processingFile = `${queueFile}.processing.${process.pid}.${Date.now()}`;
  let content = "";
  let readOk = false;
  try {
    fs.renameSync(queueFile, processingFile);
    content = fs.readFileSync(processingFile, "utf8");
    readOk = true;
  } catch {
    try {
      if (fs.existsSync(processingFile)) {
        fs.renameSync(processingFile, queueFile);
      }
    } catch {
      // ignore rollback errors
    }
    return [];
  } finally {
    if (readOk) {
      try {
        if (fs.existsSync(processingFile)) {
          fs.rmSync(processingFile, { force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
  if (!content.trim()) return [];
  return content.split(/\r?\n/).filter(Boolean);
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function parseInputMessage(message) {
  if (!message) return { raw: false, text: "" };
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object") {
      if (parsed.raw && typeof parsed.data === "string") {
        return { raw: true, text: parsed.data };
      }
      if (typeof parsed.text === "string") {
        return { raw: false, text: parsed.text };
      }
    }
  } catch {
    // ignore json parse errors
  }
  return { raw: false, text: message };
}

function buildPrompt(text, marker) {
  if (!marker) return text;
  return `${text}\n\n请在完成后输出以下标记（单独一行）：\n${marker}\n`;
}

function resolveCommand(agentType) {
  const normalizedAgent = String(agentType || "").trim().toLowerCase();
  const rawCmd = String(process.env.UFOO_PTY_CMD || "").trim();
  if (rawCmd) {
    const rawArgs = String(process.env.UFOO_PTY_ARGS || "").trim();
    const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
    return { command: rawCmd, args };
  }
  if (normalizedAgent === "claude" || normalizedAgent === "claude-code") {
    return { command: "claude", args: [] };
  }
  if (normalizedAgent === "ufoo" || normalizedAgent === "ucode" || normalizedAgent === "ufoo-code") {
    return { command: "ucode", args: [] };
  }
  return { command: "codex", args: ["--no-alt-screen", "--sandbox", "workspace-write"] };
}

async function runPtyRunner({ projectRoot, agentType = "codex" }) {
  let pty;
  try {
    // eslint-disable-next-line global-require
    pty = require("node-pty");
  } catch {
    throw new Error("node-pty not installed");
  }
  let Terminal = null;
  let SerializeAddon = null;
  try {
    const xterm = await import("xterm-headless");
    const serialize = await import("xterm-addon-serialize");
    Terminal = xterm.Terminal || (xterm.default && xterm.default.Terminal);
    SerializeAddon = serialize.SerializeAddon || (serialize.default && serialize.default.SerializeAddon);
  } catch {
    Terminal = null;
    SerializeAddon = null;
  }
  const { subscriber } = parseSubscriberId();
  const queueDir = path.join(getUfooPaths(projectRoot).busQueuesDir, safeSubscriber(subscriber));
  const queueFile = path.join(queueDir, "pending.jsonl");
  const runDir = getUfooPaths(projectRoot).runDir;
  const logFile = path.join(runDir, "pty-runner.log");
  const injectSockPath = path.join(queueDir, "inject.sock");

  const { command, args } = resolveCommand(agentType);
  const env = {
    ...process.env,
    UFOO_LAUNCH_MODE: "internal-pty",
    UFOO_INTERNAL_PTY: "1",
  };

  const eventBus = new EventBus(projectRoot);

  let running = true;
  let busy = false;
  let ptyAlive = false;
  let ptyReady = false;
  let readyTimer = null;
  let currentPublisher = "";
  let currentMarker = "";
  let pendingOutput = [];
  let outputBuffer = "";
  let flushTimer = null;
  let idleTimer = null;
  let watchdogTimer = null;
  let suppressEcho = false;
  let echoMarker = "";
  let suppressTimer = null;
  let fallbackInProgress = false;
  let ptyProcess = null;
  let restartCount = 0;
  let lastSpawnTime = 0;
  const MAX_RESTARTS = 3;
  const RESTART_STABLE_MS = 30000; // reset counter if process ran > 30s
  const RESTART_DELAY_MS = 2000;
  const READY_QUIET_MS = 3000; // TUI is "ready" after 3s of no output
  const messageQueue = [];
  const injectServer = setupInjectServer();
  initScreenBuffer(80, 24);
  const maxChunk = 2000;
  const idleMs = 30000;
  const watchdogMs = 120000;
  const maxQueue = 200;
  const watchdogAction = String(process.env.UFOO_PTY_WATCHDOG_ACTION || "restart").toLowerCase();
  let sendQueue = Promise.resolve();
  const DROP_LINE_PATTERNS = [
    /__UFOO_DONE_/,
    /请在完成后输出以下标记/,
    /context left/i,
    /esc to interrupt/i,
    /for shortcuts/i,
    /Preparing to run session start commands/i,
  ];

  function shouldDropLine(line) {
    if (!line) return true;
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^[›❯>]$/.test(trimmed)) return true;
    return DROP_LINE_PATTERNS.some((re) => re.test(trimmed));
  }

  function sanitizeChunk(chunk) {
    if (!chunk) return "";
    let text = String(chunk);
    if (text.includes("\r")) {
      const parts = text.split("\r");
      text = parts[parts.length - 1];
    }
    const lines = text.split("\n").filter((line) => !shouldDropLine(line));
    return lines.join("\n");
  }

  function enqueueSend(target, message) {
    if (!target || !message) return;
    sendQueue = sendQueue.then(() => eventBus.send(target, message, subscriber)).catch((err) => {
      logNote(`[send-error] target=${target} err=${err.message || err}`);
    });
  }

  // TTY view subscribers (same protocol as launcher inject.sock)
  const outputSubscribers = new Set();
  let term = null;
  let serializeAddon = null;
  let termWriteQueue = Promise.resolve();
  const OUTPUT_RING_MAX = (() => {
    const env = Number.parseInt(process.env.UFOO_INTERNAL_RING_MAX || "", 10);
    if (Number.isFinite(env) && env > 0) return env;
    return 512 * 1024;
  })();
  let outputRingBuffer = "";

  function initScreenBuffer(cols = 80, rows = 24) {
    if (!Terminal || !SerializeAddon) return null;
    try {
      const scrollbackEnv = Number.parseInt(process.env.UFOO_INTERNAL_SCROLLBACK || "", 10);
      const scrollback = Number.isFinite(scrollbackEnv) && scrollbackEnv >= 0
        ? scrollbackEnv
        : 20000;
      term = new Terminal({
        cols,
        rows,
        scrollback,
        allowProposedApi: true,
        convertEol: true,
      });
      serializeAddon = new SerializeAddon();
      term.loadAddon(serializeAddon);
    } catch {
      term = null;
      serializeAddon = null;
    }
    return term;
  }

  function enqueueTermWrite(data) {
    if (!term || !data) return;
    termWriteQueue = termWriteQueue.then(() => new Promise((resolve) => {
      term.write(data, resolve);
    })).catch(() => {});
  }

  function serializeBuffer(buffer, scrollback) {
    if (!term || !serializeAddon || !buffer) return "";
    try {
      if (typeof serializeAddon._serializeBuffer === "function") {
        return serializeAddon._serializeBuffer(term, buffer, scrollback);
      }
      if (buffer === term.buffer.normal && typeof serializeAddon.serialize === "function") {
        return serializeAddon.serialize({
          scrollback,
          excludeAltBuffer: true,
          excludeModes: true,
        });
      }
      return "";
    } catch {
      return "";
    }
  }

  async function serializeSnapshot(mode = "full") {
    if (!term || !serializeAddon) return null;
    try {
      await termWriteQueue;
      const active = term.buffer.active;
      const normal = term.buffer.normal;
      const scrollback = term.options && Number.isFinite(term.options.scrollback)
        ? term.options.scrollback
        : undefined;

      if (mode === "screen") {
        const screen = serializeBuffer(active, 0);
        return screen ? { data: screen } : null;
      }

      let data = serializeBuffer(normal, scrollback);
      if (active && active !== normal) {
        const alt = serializeBuffer(active, 0);
        if (alt) data += `\x1b[H${alt}`;
      }
      return data ? { data } : null;
    } catch {
      return null;
    }
  }

  function broadcastOutput(data) {
    const text = Buffer.from(data || "").toString("utf8");
    if (!text) return;
    enqueueTermWrite(text);
    outputRingBuffer += text;
    if (outputRingBuffer.length > OUTPUT_RING_MAX) {
      outputRingBuffer = outputRingBuffer.slice(-OUTPUT_RING_MAX);
    }
    if (outputSubscribers.size === 0) return;
    const msg = JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.OUTPUT, data: text, encoding: "utf8" }) + "\n";
    for (const sub of outputSubscribers) {
      try {
        sub.write(msg);
      } catch {
        outputSubscribers.delete(sub);
      }
    }
  }

  function setupInjectServer() {
    const dir = path.dirname(injectSockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(injectSockPath)) {
      try { fs.unlinkSync(injectSockPath); } catch { /* ignore */ }
    }
    const server = net.createServer((client) => {
      let buffer = "";
      client.on("data", (data) => {
        buffer += data.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line);
            if (req.type === "inject" && req.command) {
              if (ptyProcess && ptyAlive) {
                const isClaude = agentType === "claude-code";
                ptyProcess.write(String(req.command));
                if (isClaude) {
                  // Claude Code: send CR directly without ESC.
                  // ESC before CR is interpreted as Alt+Enter (newline).
                  setTimeout(() => {
                    if (ptyProcess && ptyAlive) {
                      ptyProcess.write("\r");
                    }
                  }, 200);
                } else {
                  // Codex/others: ESC dismisses autocomplete, then CR submits.
                  setTimeout(() => {
                    if (!ptyProcess || !ptyAlive) return;
                    ptyProcess.write("\x1b");
                    setTimeout(() => {
                      if (ptyProcess && ptyAlive) {
                        ptyProcess.write("\r");
                      }
                    }, 100);
                  }, 200);
                }
                client.write(JSON.stringify({ ok: true }) + "\n");
              } else {
                client.write(JSON.stringify({ ok: false, error: "pty not ready" }) + "\n");
              }
            } else if (req.type === PTY_SOCKET_MESSAGE_TYPES.RAW && typeof req.data === "string") {
              if (ptyProcess && ptyAlive) {
                ptyProcess.write(req.data);
                client.write(JSON.stringify({ ok: true }) + "\n");
              } else {
                client.write(JSON.stringify({ ok: false, error: "pty not ready" }) + "\n");
              }
            } else if (req.type === PTY_SOCKET_MESSAGE_TYPES.RESIZE && req.cols && req.rows) {
              if (ptyProcess && ptyAlive && typeof ptyProcess.resize === "function") {
                ptyProcess.resize(req.cols, req.rows);
              }
              if (term && typeof term.resize === "function") {
                try { term.resize(req.cols, req.rows); } catch { /* ignore */ }
              }
              client.write(JSON.stringify({ ok: true }) + "\n");
            } else if (req.type === PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE) {
              outputSubscribers.add(client);
              client.write(JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBED, ok: true }) + "\n");
              const mode = req.mode === PTY_SOCKET_SUBSCRIBE_MODES.SCREEN
                ? PTY_SOCKET_SUBSCRIBE_MODES.SCREEN
                : PTY_SOCKET_SUBSCRIBE_MODES.FULL;
              if (mode === PTY_SOCKET_SUBSCRIBE_MODES.FULL) {
                if (outputRingBuffer.length > 0) {
                  try {
                    client.write(JSON.stringify({
                      type: PTY_SOCKET_MESSAGE_TYPES.REPLAY,
                      data: outputRingBuffer,
                      encoding: "utf8",
                    }) + "\n");
                  } catch {
                    // ignore replay send errors
                  }
                } else {
                  serializeSnapshot(PTY_SOCKET_SUBSCRIBE_MODES.FULL).then((snapshot) => {
                    if (snapshot && snapshot.data) {
                      try {
                        client.write(JSON.stringify({
                          type: PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT,
                          data: snapshot.data,
                          encoding: "utf8",
                        }) + "\n");
                      } catch {
                        // ignore snapshot send errors
                      }
                    }
                  }).catch(() => {});
                }
              } else {
                serializeSnapshot(PTY_SOCKET_SUBSCRIBE_MODES.SCREEN).then((snapshot) => {
                  if (snapshot && snapshot.data) {
                    try {
                      client.write(JSON.stringify({
                        type: PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT,
                        data: snapshot.data,
                        encoding: "utf8",
                      }) + "\n");
                    } catch {
                      // ignore snapshot send errors
                    }
                  }
                }).catch(() => {});
              }
            } else {
              client.write(JSON.stringify({ ok: false, error: "invalid request" }) + "\n");
            }
          } catch (err) {
            client.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
          }
        }
      });
      client.on("error", () => {
        outputSubscribers.delete(client);
      });
      client.on("close", () => {
        outputSubscribers.delete(client);
      });
    });
    server.listen(injectSockPath);
    return server;
  }

  function cleanupInjectServer(server) {
    for (const sub of outputSubscribers) {
      try { sub.destroy(); } catch { /* ignore */ }
    }
    outputSubscribers.clear();
    try {
      if (server) server.close();
      if (fs.existsSync(injectSockPath)) fs.unlinkSync(injectSockPath);
    } catch {
      // ignore
    }
  }

  function flushPending() {
    if (!currentPublisher || pendingOutput.length === 0) return;
    const chunks = pendingOutput;
    pendingOutput = [];
    for (const chunk of chunks) {
      enqueueSend(currentPublisher, chunk);
    }
  }

  function deliverChunk(chunk) {
    if (!chunk) return;
    const cleaned = sanitizeChunk(chunk);
    if (!cleaned) return;
    const payload = JSON.stringify({ stream: true, delta: cleaned });
    if (currentPublisher) {
      enqueueSend(currentPublisher, payload);
    } else {
      pendingOutput.push(payload);
      if (pendingOutput.length > 50) pendingOutput.shift();
    }
  }

  function flushOutput() {
    if (!outputBuffer) return;
    const chunk = outputBuffer.slice(0, maxChunk);
    outputBuffer = outputBuffer.slice(chunk.length);
    if (chunk) {
      deliverChunk(chunk);
    }
    if (outputBuffer) {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushOutput();
    }, 120);
  }

  function logNote(note) {
    try {
      fs.mkdirSync(runDir, { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${note}\n`);
    } catch {
      // ignore
    }
  }

  function attachPty(proc) {
    proc.onData((data) => {
      const raw = String(data || "");
      broadcastOutput(raw);
      // Auto-respond to DSR (Device Status Report) cursor position query.
      // Ink/codex sends \x1b[6n at startup; node-pty doesn't reply automatically,
      // causing codex to crash with "cursor position could not be read".
      if (raw.includes("\x1b[6n") || raw.includes("\x1b[?6n")) {
        proc.write("\x1b[1;1R");
      }
      const clean = stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!clean) return;
      outputBuffer += clean;
      if (suppressEcho) {
        if (echoMarker && outputBuffer.includes(echoMarker)) {
          const idx = outputBuffer.indexOf(echoMarker);
          outputBuffer = outputBuffer.slice(idx + echoMarker.length);
          outputBuffer = outputBuffer.replace(/^\n+/, "");
          suppressEcho = false;
          currentMarker = echoMarker;
          echoMarker = "";
          if (suppressTimer) {
            clearTimeout(suppressTimer);
            suppressTimer = null;
          }
        } else {
          return;
        }
      }
      if (currentMarker) {
        const idx = outputBuffer.indexOf(currentMarker);
        if (idx !== -1) {
          const before = outputBuffer.slice(0, idx);
          outputBuffer = "";
          if (before) {
            deliverChunk(before);
          }
          if (currentPublisher) {
            enqueueSend(currentPublisher, JSON.stringify({ stream: true, done: true, reason: "marker" }));
          }
          currentMarker = "";
          busy = false;
          currentPublisher = "";
          if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          processQueue();
          return;
        }
      }
      scheduleFlush();
      // Ready detection: during TUI startup, reset the quiet timer on each output.
      // Once output stops for READY_QUIET_MS, the TUI is considered initialized.
      if (!ptyReady && !busy) {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(() => {
          readyTimer = null;
          if (!ptyReady) {
            ptyReady = true;
            // Discard TUI startup noise accumulated before ready
            outputBuffer = "";
            pendingOutput = [];
            logNote("[internal-pty] TUI ready (output quiet for " + READY_QUIET_MS + "ms)");
            processQueue();
          }
        }, READY_QUIET_MS);
      }
      if (busy) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (currentPublisher) {
            enqueueSend(currentPublisher, JSON.stringify({ stream: true, done: true, reason: "idle" }));
          }
          busy = false;
          currentPublisher = "";
          processQueue();
        }, idleMs);
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      // Skip if this process has been replaced (e.g., by restartPty)
      if (proc !== ptyProcess) return;

      ptyAlive = false;
      ptyReady = false;
      if (readyTimer) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (outputBuffer) {
        flushOutput();
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      const note = `[internal-pty] process exited code=${exitCode} signal=${signal || ""}`.trim();
      if (currentPublisher) enqueueSend(currentPublisher, note);
      logNote(note);

      // Reset busy state
      busy = false;
      currentPublisher = "";
      currentMarker = "";

      // If stop() was called, let the runner exit
      if (!running) return;

      // Auto-restart with backoff
      const elapsed = Date.now() - lastSpawnTime;
      if (elapsed > RESTART_STABLE_MS) {
        restartCount = 0; // Process was stable long enough, reset counter
      }
      restartCount++;

      if (restartCount <= MAX_RESTARTS) {
        const delay = Math.min(restartCount * RESTART_DELAY_MS, 10000);
        logNote(`Auto-restarting PTY in ${delay}ms (attempt ${restartCount}/${MAX_RESTARTS})`);
        setTimeout(() => {
          if (!running) return;
          try {
            ptyProcess = spawnPtyProcess();
            processQueue();
          } catch (err) {
            logNote(`Restart failed: ${err.message || err}`);
            void fallbackHeadless(`restart failed: ${err.message || err}`);
          }
        }, delay);
      } else {
        logNote(`Max PTY restarts (${MAX_RESTARTS}) reached, falling back to headless runner`);
        void fallbackHeadless("max PTY restarts exceeded");
      }
    });
  }

  function spawnPtyProcess() {
    lastSpawnTime = Date.now();
    ptyReady = false;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    const proc = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: projectRoot,
      env,
    });
    ptyAlive = true;
    attachPty(proc);
    return proc;
  }

  function restartPty(reason) {
    if (!running) return;
    logNote(`Restarting PTY: ${reason}`);
    ptyAlive = false;
    ptyReady = false;
    if (outputBuffer) {
      flushOutput();
    }
    // Clear reference first so the old onExit handler skips (proc !== ptyProcess)
    const oldPty = ptyProcess;
    ptyProcess = null;
    try {
      if (oldPty) oldPty.kill();
    } catch {
      // ignore
    }
    ptyProcess = spawnPtyProcess();
  }

  async function fallbackHeadless(reason) {
    if (fallbackInProgress) return;
    fallbackInProgress = true;
    logNote(`Fallback to headless: ${reason}`);
    if (outputBuffer) {
      flushOutput();
    }
    cleanupInjectServer(injectServer);
    try {
      if (ptyProcess) ptyProcess.kill();
    } catch {
      // ignore
    }
    running = false;
    await runInternalRunner({ projectRoot, agentType });
    process.exit(0);
  }

  const stop = () => {
    running = false;
    cleanupInjectServer(injectServer);
    try {
      if (ptyProcess) ptyProcess.kill();
    } catch {
      // ignore
    }
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Ignore SIGHUP so terminal closure doesn't kill the ptyRunner
  // while the daemon is still alive.
  process.on("SIGHUP", () => {});

  ptyProcess = spawnPtyProcess();

  function processQueue() {
    if (busy || messageQueue.length === 0 || !running || !ptyAlive || !ptyReady) return;
    const next = messageQueue.shift();
    if (!next) return;
    busy = true;
    currentPublisher = next.publisher;
    currentMarker = next.marker || "";
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
    flushPending();
    if (next.text) {
      if (next.raw) {
        ptyProcess.write(next.text);
      } else {
        // Write text first, then send Enter separately.
        // Codex Ink TUI requires text and submit key as separate writes.
        // IMPORTANT: Defer marker detection until after Enter is sent,
        // because the prompt echo (TextInput display) contains the marker text.
        const prompt = buildPrompt(next.text, currentMarker);
        const savedMarker = currentMarker;
        suppressEcho = true;
        echoMarker = savedMarker;
        currentMarker = ""; // Disable marker detection during prompt echo & formatted display
        ptyProcess.write(prompt);
        setTimeout(() => {
          if (ptyProcess && ptyAlive) {
            outputBuffer = "";
            const isClaude = agentType === "claude-code";
            if (isClaude) {
              // Claude Code: send CR directly without ESC.
              // ESC before CR is interpreted as Alt+Enter (newline).
              ptyProcess.write("\r");
              suppressTimer = setTimeout(() => {
                suppressTimer = null;
                if (!suppressEcho) return;
                suppressEcho = false;
                echoMarker = "";
                currentMarker = savedMarker;
                outputBuffer = "";
              }, 1500);
            } else {
              // Codex/others: ESC dismisses autocomplete, then CR submits.
              ptyProcess.write("\x1b");
              setTimeout(() => {
                if (ptyProcess && ptyAlive) {
                  ptyProcess.write("\r");
                }
                suppressTimer = setTimeout(() => {
                  suppressTimer = null;
                  if (!suppressEcho) return;
                  suppressEcho = false;
                  echoMarker = "";
                  currentMarker = savedMarker;
                  outputBuffer = "";
                }, 1500);
              }, 100);
            }
          }
        }, 200);
      }
    }
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (!busy) return;
      const timeoutNote = `[internal-pty] marker timeout; action=${watchdogAction}`;
      if (currentPublisher) enqueueSend(currentPublisher, timeoutNote);
      if (currentPublisher) {
        enqueueSend(currentPublisher, JSON.stringify({ stream: true, done: true, reason: "timeout" }));
      }
      logNote(timeoutNote);
      if (watchdogAction === "fallback") {
        void fallbackHeadless("marker timeout");
        return;
      }
      if (watchdogAction === "restart") {
        restartPty("marker timeout");
      }
      currentMarker = "";
      busy = false;
      currentPublisher = "";
      processQueue();
    }, watchdogMs);
  }

  // Heartbeat to keep agent "online" in bus status
  let lastHeartbeat = 0;
  const HEARTBEAT_INTERVAL = 30000;
  const updateHeartbeat = () => {
    try {
      spawnSync("ufoo", ["bus", "check", subscriber], {
        cwd: projectRoot,
        env: { ...process.env, UFOO_SUBSCRIBER_ID: subscriber },
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // ignore heartbeat errors
    }
  };

  while (running) {
    // Periodic heartbeat
    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      updateHeartbeat();
      lastHeartbeat = now;
    }

    const lines = drainQueue(queueFile);
    if (lines.length > 0) {
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // ignore malformed line
        }
      }
      for (const evt of events) {
        if (!evt || !evt.data || typeof evt.data.message !== "string") continue;
        const { raw, text } = parseInputMessage(evt.data.message);
        if (messageQueue.length >= maxQueue) {
          messageQueue.shift();
        }
        const marker = raw ? "" : `__UFOO_DONE_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
        const publisher = typeof evt.publisher === "object" && evt.publisher
          ? (evt.publisher.subscriber || evt.publisher.nickname || "unknown")
          : (evt.publisher || "unknown");
        messageQueue.push({ publisher, raw, text, marker });
      }
    }
    processQueue();
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
}

module.exports = { runPtyRunner };
