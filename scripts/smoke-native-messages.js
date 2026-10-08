#!/usr/bin/env node
"use strict";

// Optional local smoke test using installed vendor CLIs and an isolated fake
// model endpoint. No user settings, credentials or real inference are used.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const pty = require("node-pty");
const EventBus = require("../src/coordination/bus");
const { registerAgentFull } = require("../src/runtime/daemon/controlPlaneService");
const { resolveNativeMessageMode, setNativeMetadata } = require("../src/agents/launch/nativeMessages");
const Injector = require("../src/coordination/bus/inject");
const { getUfooPaths } = require("../src/coordination/state/paths");
const { loadAgentsData } = require("../src/coordination/state/agentsStore");

async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Native smoke condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function anthropicResponse(response, block) {
  const messageId = "msg_ufoo_fixture";
  const isTool = block.type === "tool_use";
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: messageId, type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: isTool ? { ...block, input: {} } : { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: isTool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: isTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  response.end();
}

async function main() {
  const selected = process.argv[2] || "claude";
  const legacyOptOut = process.argv.includes("--legacy");
  // macOS's per-user temp path can exceed the Unix socket length limit once
  // the wrapper's project-local bus socket suffix is appended.
  const fixtureParent = process.platform === "darwin" ? "/private/tmp" : process.env.RUNNER_TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(fixtureParent, "uf-smoke-"));
  const ptyGroupsFile = path.join(root, "fixture-pty-groups");
  const received = [];
  let probeCalled = false;
  const api = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* non-model request */ }
      if (request.url.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":1}'); return;
      }
      if (request.url.includes("messages")) {
        const messages = JSON.stringify(body.messages || []);
        const nonce = messages.match(/nonce ([0-9a-f]{48})/)?.[1];
        const tool = body.tools?.find((item) => item.name.endsWith("__channel_ready"));
        if (nonce && tool && !probeCalled) {
          probeCalled = true;
          anthropicResponse(response, { type: "tool_use", id: "tool_probe", name: tool.name, input: { nonce } });
        } else {
          for (const marker of ["ufoo_native_first", "ufoo_native_second"]) {
            if (messages.includes(marker) && !received.includes(marker)) received.push(marker);
          }
          setTimeout(() => anthropicResponse(response, { type: "text", text: "Fixture message received." }), messages.includes("ufoo_native_first") ? 300 : 0);
        }
        return;
      }
      if (request.url.includes("responses")) {
        const input = JSON.stringify(body.input || []);
        for (const marker of ["ufoo_native_first", "ufoo_native_second"]) if (input.includes(marker) && !received.includes(marker)) received.push(marker);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture message received.", annotations: [] }] };
        const send = (data) => response.write(`data: ${JSON.stringify(data)}\n\n`);
        send({ type: "response.created", response: { id: "resp_fixture", object: "response", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        send({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture message received." });
        send({ type: "response.output_item.done", output_index: 0, item });
        setTimeout(() => {
          send({ type: "response.completed", response: { id: "resp_fixture", object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
          response.end();
        }, 300);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const home = path.join(root, "home"); fs.mkdirSync(home);
  const env = { PATH: process.env.PATH, LANG: process.env.LANG || "en_US.UTF-8", TERM: "xterm-256color", SHELL: process.env.SHELL || "/bin/sh", HOME: home, CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, "claude"), ANTHROPIC_API_KEY: "ufoo-local-fixture", ANTHROPIC_BASE_URL: baseUrl, DISABLE_UPDATES: "1" };
  if (legacyOptOut) env.UFOO_NATIVE_MESSAGES = "0";
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] } }));
  fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${baseUrl}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  let terminal;
  let output = "";
  let exited = false;
  try {
    await new EventBus(root).init();
    const agentType = selected === "codex" ? "codex" : "claude-code";
    if (resolveNativeMessageMode({ agentType, env, stdinIsTTY: true, stdoutIsTTY: true }) === legacyOptOut) throw new Error("Interactive native delivery selection is incorrect");
    const identity = await registerAgentFull(root, { agentType, sessionId: "smoke001", parentPid: process.pid, launchMode: "terminal", tty: "", skipSessionResolve: true }, { validateParentPid: true, notifyDaemon: false });
    Object.assign(env, { UFOO_SUBSCRIBER_ID: identity.subscriber, UFOO_AGENT_HANDLE: identity.agent_handle });
    if (legacyOptOut) setNativeMetadata(root, identity.subscriber, { native_delivery: "stale_receiver", native_delivery_ready: true, native_delivery_instance: "stale_socket" });
    const args = selected === "codex" ? [] : ["--model", "fixture", "--allowedTools", "mcp__ufoo_channel__channel_ready", "--debug-file", path.join(root, "claude-debug.log")];
    // Exercise the full shared launcher and its inject socket. Only daemon
    // setup/registration use this fixture's already registered local identity.
    const launcherScript = `
      // Each Unix PTY owns a separate session. Record only this fixture's
      // groups so cleanup can stop vendor descendants after wrapper exit.
      const pty = require(${JSON.stringify(require.resolve("node-pty"))});
      const spawnPty = pty.spawn;
      pty.spawn = (...args) => {
        const child = spawnPty(...args);
        require("fs").appendFileSync(${JSON.stringify(ptyGroupsFile)}, String(child.pid) + "\\n");
        return child;
      };
      const Launcher = require(${JSON.stringify(path.resolve(__dirname, "../src/agents/launch/launcher"))});
      const launcher = new Launcher(${JSON.stringify(agentType)}, ${JSON.stringify(selected === "codex" ? "codex" : "claude")});
      launcher.ensureInit = async () => {};
      launcher.ensureDaemon = async () => "fixture";
      launcher.getPreRegistered = async () => ({ subscriberId: process.env.UFOO_SUBSCRIBER_ID, sessionId: "smoke001", agentHandle: process.env.UFOO_AGENT_HANDLE });
      launcher.launch(${JSON.stringify(args)});
    `;
    terminal = pty.spawn(process.execPath, ["-e", launcherScript], { cwd: root, env: { ...env, UFOO_SUPPRESS_LAUNCHER_BANNER: "1" }, name: "xterm-256color", cols: 120, rows: 40 });
    const answered = new Set();
    terminal.onExit(() => { exited = true; });
    terminal.onData((data) => {
      output = (output + data).slice(-24000);
      const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      // Answer only setup dialogs in this isolated fixture session.
      if (/want\s*to\s*use\s*this\s*API\s*key/i.test(text) && !answered.has("fixture-key")) {
        answered.add("fixture-key"); setTimeout(() => terminal.write("\x1b[A\r"), 100);
      }
      if (/local\s*development/i.test(text) && !answered.has("development-channel")) {
        answered.add("development-channel"); setTimeout(() => terminal.write("\r"), 100);
      }
      if (/(?:trust.*(?:folder|directory)|Yes,?\s*I\s*trust)/i.test(text) && !answered.has("workspace-trust")) {
        answered.add("workspace-trust");
        // Newer Claude versions default to "No, exit". This fixture creates
        // its own disposable workspace; select its trust option explicitly.
        const declineSelected = /[❯>]\s*No,?\s*exit/i.test(text);
        if (declineSelected) {
          setTimeout(() => terminal.write("\x1b[B"), 100);
          setTimeout(() => terminal.write("\r"), 400);
        } else {
          setTimeout(() => terminal.write("\r"), 100);
        }
      }
      for (const pattern of [/text\s*style.*terminal/i, /Press\s*Ente?r?\s*to\s*continue/i, /Use\s*this\s*MCP\s*server/i]) {
        if (pattern.test(text) && !answered.has(pattern.source)) {
          answered.add(pattern.source); setTimeout(() => terminal.write("\r"), 100);
        }
      }
    });
    if (legacyOptOut) {
      await until(() => loadAgentsData(getUfooPaths(root).agentsFile).agents[identity.subscriber]?.native_delivery === null
        && fs.existsSync(path.join(getUfooPaths(root).busQueuesDir, identity.subscriber.replace(/:/g, "_"), "inject.sock")));
      console.log(JSON.stringify({ host: selected, ok: true, legacy_opt_out: true, stale_receiver_cleared: true }));
      return;
    }
    await until(() => {
      if (exited) throw new Error(`${selected} exited before channel readiness`);
      return loadAgentsData(getUfooPaths(root).agentsFile).agents[identity.subscriber]?.native_delivery_ready === true;
    });
    const injector = new Injector(getUfooPaths(root).busDir, getUfooPaths(root).agentsFile);
    await injector.inject(identity.subscriber, "ufoo_native_first", { deliveryId: "smoke:1" });
    await until(() => received.includes("ufoo_native_first"));
    await injector.inject(identity.subscriber, "ufoo_native_second", { deliveryId: "smoke:2" });
    await until(() => received.includes("ufoo_native_second"));
    console.log(JSON.stringify({ host: selected, ok: true, received, native_channel_probe: selected === "codex" ? null : probeCalled }));
  } catch (err) {
    const debugFile = path.join(root, "claude-debug.log");
    const channelDiagnostics = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, "utf8").split("\n").filter((line) => /channel|ufoo_channel|growthbook/i.test(line)).slice(-20) : [];
    console.error(JSON.stringify({ host: selected, ok: false, error: err.message, probe_called: probeCalled, channel_diagnostics: channelDiagnostics, fixture_ui: output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-1800) }));
    process.exitCode = 1;
  } finally {
    const groups = new Set(terminal ? [terminal.pid] : []);
    try {
      for (const value of fs.readFileSync(ptyGroupsFile, "utf8").split("\n")) {
        const pid = Number(value);
        if (Number.isInteger(pid) && pid > 1) groups.add(pid);
      }
    } catch { /* The launcher may have failed before starting its PTY. */ }
    const signalGroups = (signal) => {
      for (const pid of groups) {
        try { process.kill(-pid, signal); }
        catch (err) { if (err.code !== "ESRCH") throw err; }
      }
    };
    signalGroups("SIGTERM");
    if (terminal && !exited) {
      terminal.kill("SIGTERM");
      try { await until(() => exited, 2500); }
      catch { terminal.kill("SIGKILL"); }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    signalGroups("SIGKILL");
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Vendor processes can finish writing state just after the wrapper exits.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
