"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  PROTOCOL,
  RAW_MARKDOWN_CAPABILITY,
  DESKTOP_HOST_CAPABILITY,
  COMMAND_NAMES,
  EVENT_NAMES,
  createEnvelope,
  encodeMessage,
  decodeMessage,
} = require("../../../src/runtime/contracts/uiProtocol");
const {
  loadWorkspaceChanges,
  loadWorkspaceDocs,
  handleWorkspaceContext,
} = require("../../../src/ui/workspaceInspector");
const {
  buildHandoffUrl,
  parseHandoffUrl,
  createDesktopHandoffServer,
  openInDesktopApp,
  buildCliCommandString,
  installCliShims,
} = require("../../../src/ui/cliHandoff");
const { createDaemonMessageRouter } = require("../../../src/app/chat/daemonMessageRouter");
const { IPC_RESPONSE_TYPES } = require("../../../src/runtime/contracts/eventContract");
const { createDesktopArchive } = require("../../../src/ui/desktopArchive");
const { startDesktopUiHost } = require("../../../src/ui/desktopUiHost");

function makeTempDir(prefix = "ufd-") {
  const shortBase = process.platform === "darwin" && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(shortBase, prefix));
}

describe("Desktop GUI Phase 0 Core & Shared UI Host", () => {
  test("uiProtocol exposes desktop capabilities, commands, and events", () => {
    expect(RAW_MARKDOWN_CAPABILITY).toBe("markdown-raw-v1");
    expect(DESKTOP_HOST_CAPABILITY).toBe("desktop-host-v1");
    for (const cmd of [
      "project.add",
      "project.archive",
      "session.archive",
      "side.select",
      "worker.focus_view",
      "worker.launch",
      "worker.resume",
      "workspace.changes",
      "workspace.docs",
      "workspace.context",
      "handoff.to_cli",
      "handoff.open_url",
      "cli.install_shims",
    ]) {
      expect(COMMAND_NAMES).toContain(cmd);
    }
    for (const evt of [
      "projects.tree",
      "worker.view.frame",
      "workspace.changes.snapshot",
      "workspace.docs.snapshot",
      "workspace.context.snapshot",
      "handoff.state",
    ]) {
      expect(EVENT_NAMES).toContain(evt);
    }
  });

  test("desktop archive persists folder and session visibility independently", () => {
    const tmp = makeTempDir();
    try {
      const archive = createDesktopArchive(tmp);
      const root = path.join(tmp, "project");
      const otherRoot = path.join(tmp, "other-project");
      archive.archiveSession(root, "worker-1");
      archive.archiveSession(root, "worker-1");
      archive.archiveSession(otherRoot, "worker-1");
      archive.archiveProject(root);
      const reopened = createDesktopArchive(tmp);
      expect(reopened.read()).toEqual({
        projects: [{ root }],
        sessions: [{ root, id: "worker-1" }, { root: otherRoot, id: "worker-1" }],
      });
      reopened.restoreProject(root);
      expect(archive.read().projects).toEqual([]);
      expect(archive.read().sessions).toHaveLength(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Go Window targets a registered terminal session or Codex thread before falling back to an app", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const run = jest.spyOn(require("child_process"), "spawnSync").mockReturnValue({ status: 0, stdout: "ok" });
    let focusExternalAgentHost;
    try {
      jest.isolateModules(() => {
        ({ focusExternalAgentHost } = require("../../../src/ui/cliHandoff"));
      });
      const root = "/workspace";
      const tty = "/dev/ttys019";
      const terminal = { host_name: "ufoo-mcp", terminal_app: "terminal", tty };
      expect(await focusExternalAgentHost(root, terminal)).toEqual({ ok: true, appName: "Terminal", method: "session" });
      expect(run).toHaveBeenLastCalledWith("osascript", ["-e", expect.stringContaining("set selected tab of w to t"), tty], expect.any(Object));

      const iterm = { ...terminal, terminal_app: "iterm2" };
      expect(await focusExternalAgentHost(root, iterm)).toEqual({ ok: true, appName: "iTerm", method: "session" });
      expect(run).toHaveBeenLastCalledWith("osascript", ["-e", expect.stringContaining("select s"), tty], expect.any(Object));

      const threadId = "01234567-89ab-cdef-0123-456789abcdef";
      const codex = { host_name: "ufoo-mcp", mcp_metadata: { host_name: "codex", provider_session_id: threadId } };
      expect(await focusExternalAgentHost(root, codex)).toEqual({ ok: true, appName: "Codex", method: "deep_link" });
      expect(run).toHaveBeenLastCalledWith("open", [`codex://threads/${threadId}`], expect.any(Object));

      run.mockReturnValueOnce({ status: 0, stdout: "not found" });
      expect(await focusExternalAgentHost(root, terminal)).toEqual({ ok: true, appName: "Terminal", method: "app" });
      expect(run).toHaveBeenLastCalledWith("open", ["-a", "Terminal"], expect.any(Object));
      expect(await focusExternalAgentHost(root, { host_name: "Antigravity" })).toEqual({ ok: true, appName: "Antigravity", method: "app" });
      expect(run).toHaveBeenLastCalledWith("open", ["-a", "Antigravity"], expect.any(Object));

      run.mockClear();
      expect(await focusExternalAgentHost(root, { host_name: "ufoo-mcp" })).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });

  test("daemonMessageRouter renders peer user prompt bubbles and clears answered interactions without duplicating own requests", () => {
    const logged = [];
    const interactions = [];
    const cleared = [];
    const router = createDaemonMessageRouter({
      isOwnRequestId: (id) => id === "own-req-1",
      logMessage: (kind, text) => logged.push({ kind, text }),
      onInteractionRequest: (item) => interactions.push(item),
      onInteractionClear: (item) => cleared.push(item),
    });

    // Own request must NOT duplicate user bubble
    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RUNTIME_EVENT,
      data: {
        projectId: "p1",
        sessionId: "main-default",
        sequence: 1,
        taskRunId: "run-1",
        agentId: "ufoo-agent",
        type: "request.accepted",
        request: { requestId: "own-req-1", text: "from this client" },
      },
    });
    expect(logged.filter((l) => l.kind === "user")).toHaveLength(0);

    // Peer request (e.g. sent from CLI while GUI is open) MUST render user bubble once
    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RUNTIME_EVENT,
      data: {
        projectId: "p1",
        sessionId: "main-default",
        sequence: 2,
        taskRunId: "run-2",
        agentId: "ufoo-agent",
        type: "request.accepted",
        request: { requestId: "peer-req-2", text: "sent from terminal CLI" },
      },
    });
    expect(logged.filter((l) => l.kind === "user")).toEqual([
      { kind: "user", text: "sent from terminal CLI" },
    ]);

    // Pause -> interaction.request -> answered -> interaction.clear
    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RUNTIME_EVENT,
      data: {
        projectId: "p1",
        sessionId: "main-default",
        sequence: 3,
        taskRunId: "run-2",
        agentId: "ufoo-agent",
        type: "task.paused",
        result: {
          executionState: {
            pendingUserInteraction: {
              id: "int-42",
              prompt: "Approve schema?",
              options: [{ key: "1", label: "Approve" }],
            },
          },
        },
      },
    });
    expect(interactions).toHaveLength(1);
    expect(interactions[0].id).toBe("int-42");

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RUNTIME_EVENT,
      data: {
        projectId: "p1",
        sessionId: "main-default",
        sequence: 4,
        taskRunId: "run-2",
        agentId: "ufoo-agent",
        type: "interaction.answered",
        interactionId: "int-42",
      },
    });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].id).toBe("int-42");
  });

  test("workspaceInspector reads git changes, docs with line anchors, decisions, and shared memory", () => {
    const tmp = makeTempDir("ufoo-inspector-");
    try {
      spawnSync("git", ["init", "-b", "main"], { cwd: tmp });
      spawnSync("git", ["config", "user.email", "test@ufoo.dev"], { cwd: tmp });
      spawnSync("git", ["config", "user.name", "Ufoo Test"], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, "README.md"), "# Sample Project\nLine 2\nLine 3\n", "utf8");
      spawnSync("git", ["add", "README.md"], { cwd: tmp });
      spawnSync("git", ["commit", "-m", "init"], { cwd: tmp });

      fs.writeFileSync(path.join(tmp, "README.md"), "# Sample Project\nUpdated Line 2\nLine 3\nNew Line 4\n", "utf8");
      fs.writeFileSync(path.join(tmp, "notes.js"), "const x = 42;\nmodule.exports = x;\n", "utf8");

      const changes = loadWorkspaceChanges(tmp, { filePath: "README.md" });
      expect(changes.isGitRepo).toBe(true);
      expect(changes.branch).toBe("main");
      expect(changes.files.map((f) => f.path)).toEqual(expect.arrayContaining(["README.md", "notes.js"]));
      expect(changes.diff).toContain("+Updated Line 2");

      const docs = loadWorkspaceDocs(tmp, { filePath: "notes.js#L2" });
      expect(docs.document.path).toBe("notes.js");
      expect(docs.document.anchorLine).toBe(2);
      expect(docs.document.language).toBe("javascript");
      expect(docs.document.content).toContain("const x = 42;");

      // Escape attempts are rejected safely
      const escaped = loadWorkspaceDocs(tmp, { filePath: "../../etc/passwd" });
      expect(escaped.document.error).toMatch(/escapes workspace root/i);

      // Context: Decisions + Memory CRUD
      let ctx = handleWorkspaceContext(tmp, {
        operation: "decision.create",
        title: "Adopt Tauri v2 for macOS GUI",
        context: "Need native vibrancy and shared daemon core.",
        decision: "Use Tauri v2 + desktopUiHost.",
      });
      expect(ctx.decisions).toHaveLength(1);
      expect(ctx.openDecisionCount).toBe(1);

      const createdFile = ctx.decisions[0].file;
      ctx = handleWorkspaceContext(tmp, {
        operation: "decision.set_status",
        file: createdFile,
        status: "resolved",
      });
      expect(ctx.openDecisionCount).toBe(0);
      expect(ctx.decisions[0].status).toBe("resolved");

      ctx = handleWorkspaceContext(tmp, {
        operation: "memory.add",
        title: "GUI Daemon Rule",
        body: "Desktop GUI connects to ~/.ufoo/run/ufoo.sock and never forks daemon state.",
        tags: ["architecture", "gui"],
      });
      expect(ctx.memories).toHaveLength(1);
      expect(ctx.memories[0].tags).toEqual(["architecture", "gui"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("cliHandoff builds/parses deep links, wakes running desktop over socket, and installs CLI shims", async () => {
    const tmp = makeTempDir("ufoo-handoff-");
    const sockPath = path.join(tmp, "handoff.sock");
    const received = [];
    const server = createDesktopHandoffServer({
      socketPath: sockPath,
      onHandoff: (payload) => received.push(payload),
    });
    await server.listen();
    try {
      const url = buildHandoffUrl({
        projectRoot: tmp,
        target: "ucode:1234abcd",
        windowMode: "side",
        docPath: "docs/PROJECT.md",
      });
      const parsed = parseHandoffUrl(url);
      expect(parsed.target).toBe("ucode:1234abcd");
      expect(parsed.windowMode).toBe("side");
      expect(parsed.docPath).toBe("docs/PROJECT.md");

      const res = await openInDesktopApp({
        projectRoot: tmp,
        target: "ucode:1234abcd",
        socketPath: sockPath,
        skipOsActivate: true,
      });
      expect(res.ok).toBe(true);
      expect(res.method).toBe("socket");
      expect(received).toHaveLength(1);
      expect(received[0].target).toBe("ucode:1234abcd");

      const cmdStr = buildCliCommandString({
        projectRoot: tmp,
        windowMode: "multi",
      });
      expect(cmdStr).toContain("chat --project");
      expect(cmdStr).toContain("--window 'multi'");

      const shimDir = path.join(tmp, "bin");
      const shims = installCliShims({
        targetDir: shimDir,
        tuiBinary: "/tmp/fake-ufoo-tui",
      });
      expect(shims.ok).toBe(true);
      expect(fs.existsSync(path.join(shimDir, "ufoo"))).toBe(true);
      expect(fs.existsSync(path.join(shimDir, "ucode"))).toBe(true);
      const ufooShimContent = fs.readFileSync(path.join(shimDir, "ufoo"), "utf8");
      expect(ufooShimContent).toContain("UFOO_NODE_EXECUTABLE=");
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("desktopUiHost authenticates, publishes project+worker tree, switches window modes and worker views", async () => {
    const tmp = makeTempDir("ufoo-dhost-");
    const projectDir = path.join(tmp, "demo-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo Project\n", "utf8");

    // Mock lightweight fake GlobalDaemon socket so we test desktopUiHost hermetically and fast
    const daemonSock = path.join(tmp, "ufoo.sock");
    const fakeDaemon = net.createServer((socket) => {
      // Switching projects disconnects the previous daemon socket, even if
      // a status response is still in flight.
      socket.on("error", (error) => {
        if (!["EPIPE", "ECONNRESET"].includes(error.code)) throw error;
      });
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          const req = JSON.parse(line);
          if (req.type === "status") {
            socket.write(`${JSON.stringify({
              type: "status",
              data: {
                projectRoot: req.project_root || projectDir,
                active: ["ucode:a1b2c3d4", "cursor:99887766"],
                active_meta: [
                  {
                    id: "ucode:a1b2c3d4",
                    nickname: "ucode-1",
                    agent_type: "ucode",
                    launch_mode: "internal",
                    activity_state: "working",
                    activity_detail: "Editing cache.js",
                  },
                  {
                    id: "cursor:99887766",
                    nickname: "cursor-1",
                    agent_type: "cursor",
                    launch_mode: "external",
                    mcp_bridge: true,
                    activity_state: "idle",
                    host_name: "Cursor",
                  },
                ],
              },
            })}\n`);
          } else if (req.type === "list_recoverable_agents") {
            socket.write(`${JSON.stringify({
              type: "response",
              data: { recoverable: { recoverable: [], groups: [] } },
            })}\n`);
          } else if (req.type === "bus_send") {
            socket.write(`${JSON.stringify({ type: "bus_send_ok", request_id: req.request_id })}\n`);
          }
        }
      });
    });
    await new Promise((resolve) => fakeDaemon.listen(daemonSock, resolve));

    const controllerDir = path.join(tmp, "controller");
    fs.mkdirSync(path.join(controllerDir, ".ufoo", "run"), { recursive: true });
    // Point controller ufoo.sock to our fake daemon via symlink
    fs.symlinkSync(daemonSock, path.join(controllerDir, ".ufoo", "run", "ufoo.sock"));

    const uiSock = path.join(tmp, "ui.sock");
    const handoffSock = path.join(tmp, "handoff.sock");
    const prevControllerEnv = process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
    process.env.UFOO_GLOBAL_CONTROLLER_ROOT = controllerDir;

    let hostHandle = null;
    try {
      hostHandle = await startDesktopUiHost({
        controllerRoot: controllerDir,
        initialProjectRoot: projectDir,
        socketPath: uiSock,
        authToken: "secret-test-token-1234",
        handoffSocketPath: handoffSock,
        isRunning: () => true,
        startDaemon: () => {},
      });

      const envelopes = [];
      const client = net.createConnection(uiSock);
      await new Promise((resolve) => client.once("connect", resolve));

      async function waitForEnvelope(matches) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const envelope = envelopes.find(matches);
          if (envelope) return envelope;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out waiting for a desktop UI envelope");
      }

      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const decoded = decodeMessage(line);
          if (decoded.ok) envelopes.push(decoded.envelope);
        }
      });

      client.write(encodeMessage(createEnvelope({
        kind: "hello",
        payload: {
          auth_token: "secret-test-token-1234",
          capabilities: [RAW_MARKDOWN_CAPABILITY, DESKTOP_HOST_CAPABILITY, "multi-frames-v1", "window-modes-v1"],
        },
      })));

      await waitForEnvelope((e) => e.name === "projects.tree" && e.payload.projects.some(
        (p) => p.label === "demo-proj" && p.workers.some((w) => w.label === "cursor-1")
      ));
      expect(envelopes.some((e) => e.kind === "welcome")).toBe(true);
      expect(envelopes.some((e) => e.name === "app.snapshot")).toBe(true);
      const treeEvent = envelopes.filter((e) => e.name === "projects.tree").pop();
      expect(treeEvent).toBeDefined();
      const demoNode = treeEvent.payload.projects.find((p) => p.label === "demo-proj");
      expect(demoNode).toBeDefined();
      expect(demoNode.workers.map((w) => w.label)).toEqual(expect.arrayContaining(["ucode-1", "cursor-1"]));
      expect(demoNode.workers.find((w) => w.label === "ucode-1").internal).toBe(true);
      expect(demoNode.workers.find((w) => w.label === "cursor-1").external).toBe(true);

      // Switch to Side mode on project root (`ufoo agent`)
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "side.select",
        requestId: "cmd-side",
        payload: { agent_id: "ucode:a1b2c3d4" },
      })));
      const sideResult = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-side");
      expect(sideResult?.payload?.ok).toBe(true);
      expect(sideResult?.payload?.mode).toBe("side");

      // Switch to 2nd-level Worker Single View (`ucode:a1b2c3d4`)
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "worker.focus_view",
        requestId: "cmd-worker",
        payload: { agent_id: "ucode:a1b2c3d4" },
      })));
      const workerResult = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-worker");
      expect(workerResult?.payload?.ok).toBe(true);
      expect(workerResult?.payload?.stage_target).toEqual({
        kind: "worker_single",
        agentId: "ucode:a1b2c3d4",
      });
      expect(envelopes.some((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4")).toBe(true);

      const latestTree = () => envelopes.filter((e) => e.name === "projects.tree").at(-1).payload;
      const archiveCommand = async (name, payload) => {
        client.write(encodeMessage(createEnvelope({ kind: "command", name, requestId: name, payload })));
        const result = await waitForEnvelope((e) => e.kind === "result" && e.request_id === name);
        expect(result.payload).toMatchObject({ ok: true });
      };
      const root = fs.realpathSync(projectDir);
      await archiveCommand("session.archive", { root, session_id: "ucode:a1b2c3d4" });
      expect(latestTree().stage_target.kind).toBe("project_main");
      expect(latestTree().projects.find((p) => p.root === root).workers.map((w) => w.id)).not.toContain("ucode:a1b2c3d4");

      await archiveCommand("project.archive", { root });
      expect(latestTree().scope).toBe("controller");
      expect(latestTree().projects.some((p) => p.root === root)).toBe(false);

      await archiveCommand("project.add", { root });
      expect(latestTree().projects.some((p) => p.root === root)).toBe(true);

      client.destroy();
    } finally {
      if (prevControllerEnv === undefined) delete process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
      else process.env.UFOO_GLOBAL_CONTROLLER_ROOT = prevControllerEnv;
      if (hostHandle) await hostHandle.close();
      await new Promise((resolve) => fakeDaemon.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
