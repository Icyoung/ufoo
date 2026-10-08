"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { version } = require("../../../package.json");
const { submissionId, withNativeReceipts } = require("../../coordination/bus/nativeReceipts");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { getUfooPaths } = require("../../coordination/state/paths");
const { loadAgentsData, updateAgentsData } = require("../../coordination/state/agentsStore");
const { persistProviderSession } = require("../../runtime/daemon/providerSessions");

function nativeError(message, code = "native_not_ready") {
  return Object.assign(new Error(message), { code });
}

const CODEX_COMMANDS_WITHOUT_CHANNELS = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin",
  "app-server", "remote-control", "app", "completion", "update", "doctor",
  "sandbox", "debug", "apply", "a", "queue", "archive", "delete",
  "migrate-rollouts", "unarchive", "cloud", "exec-server", "features", "help",
]);
const CLAUDE_COMMANDS_WITHOUT_CHANNELS = new Set([
  "agents", "auth", "mcp", "plugin", "plugins", "doctor", "install",
  "setup-token", "update", "upgrade", "gateway", "auto-mode", "project", "ultrareview",
]);
const CODEX_VALUE_FLAGS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "-p", "--profile", "-s", "--sandbox",
  "-C", "--cd", "--add-dir", "-a", "--ask-for-approval", "--local-provider",
]);
const CLAUDE_VALUE_FLAGS = new Set([
  "--add-dir", "--agent", "--agents", "--allowedTools", "--allowed-tools",
  "--append-system-prompt", "--append-system-prompt-file", "--betas", "-d", "--debug",
  "--debug-file", "--disallowedTools", "--disallowed-tools", "--effort",
  "--fallback-model", "--file", "--input-format", "--json-schema", "--max-budget-usd",
  "--mcp-config", "--model", "-n", "--name", "--output-format", "--permission-mode",
  "--plugin-dir", "--plugin-url", "--prompt-suggestions", "-r", "--resume",
  "--remote-control", "--remote-control-session-name-prefix", "--session-id",
  "--setting-sources", "--settings", "--system-prompt", "--system-prompt-file",
  "--tools", "-w", "--worktree",
]);

function isInteractiveNativeCommand(agentType, args = []) {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  if (options.some((arg) => ["--help", "-h", "--version", "-v", "-V"].includes(arg))) return false;
  if (agentType === "codex" && options.some((arg) => /^--remote(?:=|$)/.test(arg))) return false;
  if (agentType === "claude-code" && options.some((arg) => /^(?:-p$|--print(?:=|$)|--input-format(?:=|$)|--safe-mode$)/.test(arg))) return false;
  const valueFlags = agentType === "codex" ? CODEX_VALUE_FLAGS : CLAUDE_VALUE_FLAGS;
  const commands = agentType === "codex" ? CODEX_COMMANDS_WITHOUT_CHANNELS : CLAUDE_COMMANDS_WITHOUT_CHANNELS;
  for (let i = 0; i < options.length; i += 1) {
    if (valueFlags.has(options[i])) { i += 1; continue; }
    if (!String(options[i]).startsWith("-")) return !commands.has(options[i]);
  }
  return true;
}

function resolveNativeMessageMode({ agentType, args = [], env = process.env,
  stdinIsTTY = process.stdin.isTTY, stdoutIsTTY = process.stdout.isTTY,
  platform = process.platform } = {}) {
  if (!["codex", "claude-code"].includes(agentType) || env.UFOO_NATIVE_MESSAGES === "0") return false;
  if (platform === "win32" || env.UFOO_INTERNAL_AGENT || env.UFOO_DISABLE_PTY === "1") return false;
  if (env.UFOO_FORCE_PTY !== "1" && !(stdinIsTTY && stdoutIsTTY)) return false;
  return isInteractiveNativeCommand(agentType, args);
}

function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let killTimer;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      killTimer = setTimeout(resolve, 200);
    }, 500);
    child.once("close", () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
    child.kill("SIGTERM");
  });
}

function setNativeMetadata(projectRoot, subscriber, patch) {
  const file = getUfooPaths(projectRoot).agentsFile;
  updateAgentsData(file, (data) => {
    const meta = data.agents[subscriber];
    if (!meta || meta.status !== "active") throw nativeError("Native receiver has no active host identity");
    Object.assign(meta, patch);
  });
}

// Claude's variadic options must be extended in place: repeating them can
// replace configs/channels the caller already supplied.
function appendVariadic(args, flag, value) {
  const result = [...args];
  const index = result.findIndex((arg) => arg === flag || String(arg).startsWith(`${flag}=`));
  if (index < 0) {
    const separator = result.indexOf("--");
    result.splice(separator < 0 ? result.length : separator, 0, flag, value);
  } else {
    if (result[index] !== flag) result.splice(index, 1, flag, String(result[index]).slice(flag.length + 1));
    let end = index + 1;
    while (end < result.length && !String(result[end]).startsWith("-")) end += 1;
    result.splice(end, 0, value);
  }
  return result;
}

class CodexRpc {
  constructor(url, options = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs || 10000;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url, { handshakeTimeout: this.timeoutMs });
    this.ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(nativeError(message.error.message), { remoteRejected: true }));
      else pending.resolve(message.result);
    });
    this.ws.on("error", () => {});
    this.ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(nativeError("Codex connection closed", "native_outcome_unknown"));
      }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    await this.call("initialize", { clientInfo: { name: "ufoo", version }, capabilities: { experimentalApi: true } });
    this.ws.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  call(method, params) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(nativeError("Codex receiver is disconnected"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(nativeError(`Codex ${method} response timed out`, "native_outcome_unknown"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(nativeError(err.message, "native_outcome_unknown"));
      });
    });
  }

  close() { this.ws?.terminate(); }
}

async function startCodexHost({ command = "codex", args = [], projectRoot, subscriber, directory, env = process.env, spawnImpl = spawn }) {
  const remote = `unix://${path.join(directory, "codex.sock")}`;
  if (!isInteractiveNativeCommand("codex", args)) throw nativeError("Native messages require an interactive Codex session without --remote");
  // Forward config overrides to the host; model/session flags remain on the TUI.
  const configArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (["-c", "--config", "--enable", "--disable"].includes(args[i])) { configArgs.push(args[i], args[++i]); }
    else if (String(args[i]).startsWith("--config=")) configArgs.push(args[i]);
  }
  const child = spawnImpl(command, ["app-server", "--listen", remote, ...configArgs], {
    cwd: projectRoot, env, stdio: ["ignore", "ignore", "pipe"],
  });
  let startupError;
  child.on("error", (err) => { startupError = err; });
  // Consume diagnostics without logging credentials or mixing JSON into the TUI.
  child.stderr?.resume();
  const tuiSocket = path.join(directory, "codex-tui.sock");
  const tuiRemote = `unix://${tuiSocket}`;
  const bridge = http.createServer();
  const wss = new WebSocket.Server({ server: bridge });
  let threadId = "";
  let connected = false;
  let ready = false;
  const readyCallbacks = new Set();
  const setReady = () => {
    ready = connected && Boolean(threadId) && child.exitCode === null && !closing;
    const meta = loadAgentsData(getUfooPaths(projectRoot).agentsFile).agents[subscriber];
    if (meta?.status === "active" && meta.native_delivery_instance === remote) {
      setNativeMetadata(projectRoot, subscriber, { native_delivery_ready: ready });
    }
    if (ready) { for (const callback of readyCallbacks) callback(); readyCallbacks.clear(); }
  };
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    connected = false;
    setReady();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    if (bridge.listening) await new Promise((resolve) => bridge.close(resolve));
    await stopChild(child);
  };
  try {
    const deadline = Date.now() + 10000;
    do {
      if (startupError || child.exitCode !== null) throw startupError || nativeError("Codex app-server exited during startup");
      if (fs.existsSync(path.join(directory, "codex.sock"))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    if (!fs.existsSync(path.join(directory, "codex.sock"))) throw nativeError("Codex app-server socket did not become available");
    setNativeMetadata(projectRoot, subscriber, { native_delivery: "codex_queue", native_delivery_ready: false, native_delivery_instance: remote });
    child.once("exit", () => { connected = false; setReady(); });
    wss.on("connection", (frontend) => {
      if (connected || closing) { frontend.close(1008, "A TUI is already attached"); return; }
      connected = true;
      const requests = new Map();
      const upstream = new WebSocket(`ws+unix://${path.join(directory, "codex.sock")}:/`);
      const buffered = [];
      const forward = (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else buffered.push({ data, binary });
      };
      frontend.on("message", (data, binary) => {
        try {
          const message = JSON.parse(data.toString());
          if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
            requests.set(message.id, { ephemeral: message.params?.ephemeral === true });
          }
        } catch { /* forward frames unchanged */ }
        forward(data, binary);
      });
      upstream.on("open", () => { for (const item of buffered) upstream.send(item.data, { binary: item.binary }); buffered.length = 0; });
      upstream.on("message", (data, binary) => {
        let boundThread = false;
        try {
          const message = JSON.parse(data.toString());
          if (requests.has(message.id)) {
            const request = requests.get(message.id);
            requests.delete(message.id);
            const id = message.result?.thread?.id;
            // The TUI also starts temporary structured-output threads. They
            // cannot receive queued work and must not replace its user thread.
            if (id && !request.ephemeral && message.result.thread.ephemeral !== true) {
              if (!persistProviderSession(projectRoot, subscriber, { sessionId: id, source: "codex-native-app-server" })) {
                throw nativeError("Cannot bind this Codex thread to the host identity");
              }
              threadId = id;
              boundThread = true;
            }
          }
        } catch (err) {
          if (err.code === "native_not_ready") { frontend.close(1008, err.message); upstream.terminate(); return; }
        }
        if (frontend.readyState === WebSocket.OPEN) frontend.send(data, { binary }, (err) => { if (!err && boundThread) setReady(); });
      });
      frontend.on("error", () => {});
      upstream.on("error", () => frontend.terminate());
      frontend.once("close", () => { connected = false; setReady(); upstream.terminate(); });
      upstream.once("close", () => frontend.terminate());
    });
    await new Promise((resolve, reject) => { bridge.once("error", reject); bridge.listen(tuiSocket, resolve); });
    fs.chmodSync(tuiSocket, 0o600);
    // Observe the actual TUI's thread response without changing any frames.
    // Precreating a thread then resuming it fails before its first user turn:
    // Codex has not materialized that thread's rollout yet.
    return {
      args: ["--remote", tuiRemote, ...args],
      onReady(callback) { if (ready) callback(); else readyCallbacks.add(callback); },
      async send(request) {
        if (!ready) throw nativeError("Codex TUI has not confirmed host readiness");
        const receiver = new CodexRpc(`ws+unix://${path.join(directory, "codex.sock")}:/`);
        let submitted = false;
        try {
          await receiver.connect();
          submitted = true;
          const result = await receiver.call("thread/queue/add", {
            threadId,
            input: [{ type: "text", text: request.command, text_elements: [] }],
            clientUserMessageId: submissionId(`${subscriber}:${request.deliveryId}`),
          });
          if (!result?.queuedSubmission) throw nativeError("Codex returned no queue acceptance", "native_outcome_unknown");
          return { queued: true, thread_id: threadId };
        } catch (err) {
          if (!submitted) throw nativeError(`Codex receiver unavailable: ${err.message}`);
          throw err;
        } finally { receiver.close(); }
      },
      close,
    };
  } catch (err) { await close(); throw err; }
}

function sendChannel(socketPath, request) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";
    let sent = false;
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => finish(nativeError("Claude channel response timed out", sent ? "native_outcome_unknown" : "native_not_ready")), 4000);
    client.once("connect", () => { sent = true; client.write(`${JSON.stringify(request)}\n`); });
    client.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        finish(result.ok ? null : nativeError(result.error, result.code), result);
      } catch (err) { finish(nativeError(err.message, "native_outcome_unknown")); }
    });
    client.once("error", (err) => finish(nativeError(err.message, sent ? "native_outcome_unknown" : "native_not_ready")));
    client.once("end", () => { if (!buffer.includes("\n")) finish(nativeError("Claude channel closed without a receipt", "native_outcome_unknown")); });
  });
}

async function prepareNativeMessages({ agentType, command, args, projectRoot, subscriber, env = process.env }) {
  if (process.platform === "win32") throw nativeError("Native message sockets currently require macOS or Linux");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ufn-"));
  fs.chmodSync(directory, 0o700);
  let backend;
  try {
    if (agentType === "codex") {
      backend = await startCodexHost({ command, args, projectRoot, subscriber, directory, env });
    } else if (agentType === "claude-code") {
      if (args.some((arg) => /^(?:-p$|--print(?:=|$)|--input-format(?:=|$)|--safe-mode$)/.test(arg))) throw nativeError("Claude channels require an interactive session with MCP enabled");
      const channelSocket = path.join(directory, "claude.sock");
      setNativeMetadata(projectRoot, subscriber, { native_delivery: "claude_channel", native_delivery_ready: false, native_delivery_instance: channelSocket });
      const config = JSON.stringify({ mcpServers: { ufoo_channel: {
        command: process.execPath,
        args: [path.resolve(__dirname, "../../../bin/ufoo.js"), "mcp", "channel"],
      } } });
      backend = {
        args: appendVariadic(appendVariadic(args, "--mcp-config", config), "--dangerously-load-development-channels", "server:ufoo_channel"),
        env: { UFOO_NATIVE_CHANNEL_SOCK: channelSocket },
        send: (request) => sendChannel(channelSocket, request),
        close: async () => {},
      };
    } else throw nativeError(`Native messages are not supported for ${agentType}`);

    backend.send = withNativeReceipts({ projectRoot, subscriber, send: backend.send });
    const originalClose = backend.close;
    backend.close = async () => {
      await originalClose();
      fs.rmSync(directory, { recursive: true, force: true });
    };
    return backend;
  } catch (err) { fs.rmSync(directory, { recursive: true, force: true }); throw err; }
}

module.exports = { CodexRpc, startCodexHost, prepareNativeMessages, resolveNativeMessageMode, setNativeMetadata, submissionId, sendChannel, nativeError };
