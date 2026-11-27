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
  buildDecisionTidyPrompt,
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
const { startDesktopUiHost, readActiveBackgroundTasks } = require("../../../src/ui/desktopUiHost");

function makeTempDir(prefix = "ufd-") {
  const shortBase = process.platform === "darwin" && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(shortBase, prefix));
}

describe("Desktop GUI Phase 0 Core & Shared UI Host", () => {
  test("task bubbles show only queued and running work from the current conversation", () => {
    const root = makeTempDir();
    try {
      const dir = path.join(root, ".ufoo/agent/main-control/runtimes/control");
      fs.mkdirSync(dir, { recursive: true });
      const job = (taskId, status, parentSessionId = "main") => ({ taskId, status, parentSessionId, title: taskId });
      fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({ capabilityState: {
        "agent-management": { value: { tasks: { a: job("a", "running"), b: job("b", "reported"), c: job("c", "queued", "other") } } },
        "task-execution": { value: { jobs: { d: job("d", "queued"), e: job("e", "completed") } } },
      } }));
      expect(readActiveBackgroundTasks(root, "main").map(task => [task.id, task.status]))
        .toEqual([["a", "running"], ["d", "queued"]]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("uiProtocol exposes desktop capabilities, commands, and events", () => {
    expect(RAW_MARKDOWN_CAPABILITY).toBe("markdown-raw-v1");
    expect(DESKTOP_HOST_CAPABILITY).toBe("desktop-host-v1");
    for (const cmd of [
      "project.add",
      "project.archive",
      "session.archive",
      "session.unarchive",
      "session.rename",
      "session.pin",
      "session.delete",
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
      "daemon.service.status",
      "daemon.service.install",
      "daemon.service.uninstall",
      "daemon.restart",
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
      "host.connection",
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
      archive.restoreSession(root, "worker-1");
      expect(archive.read().sessions).toEqual([{ root: otherRoot, id: "worker-1" }]);

      const { createDesktopSessionPrefs } = require("../../../src/ui/desktopSessionPrefs");
      const prefs = createDesktopSessionPrefs(tmp);
      prefs.setLabel(root, "worker-1", "Refactor Auth");
      prefs.setPinned(root, "worker-1", true);
      prefs.setArchivedMeta(root, "worker-1", { type: "codex", label: "Refactor Auth", internal: true });
      expect(prefs.read().labels).toEqual([{ root, id: "worker-1", label: "Refactor Auth" }]);
      expect(prefs.read().pinned).toHaveLength(1);
      expect(prefs.read().archivedMeta[0]).toMatchObject({ root, id: "worker-1", type: "codex" });
      prefs.rekeySession(root, "worker-1", "worker-2");
      expect(prefs.read().labels[0].id).toBe("worker-2");
      prefs.purgeSession(root, "worker-2");
      expect(prefs.read()).toEqual({ pinned: [], labels: [], archivedMeta: [] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

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
    const synced = [];
    const router = createDaemonMessageRouter({
      isOwnRequestId: (id) => id === "own-req-1",
      logMessage: (kind, text) => logged.push({ kind, text }),
      onInteractionRequest: (item) => interactions.push(item),
      onInteractionClear: (item) => cleared.push(item),
      onInteractionsSync: (list) => synced.push(list),
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

    // STATUS must ignore non-waiting_user tasks and forward sessionId/taskRunId for live ones
    router.handleMessage({
      type: IPC_RESPONSE_TYPES.STATUS,
      data: {
        agent_runtime: {
          sessions: [{
            sessionId: "main-bus",
            tasks: [
              {
                taskRunId: "run-done",
                status: "running",
                interaction: { id: "int-stale", prompt: "Already answered" },
              },
              {
                taskRunId: "run-wait",
                status: "waiting_user",
                interaction: { id: "int-live", prompt: "Still waiting" },
              },
            ],
          }],
          children: [],
        },
      },
    });
    expect(interactions.map((i) => i.id)).toEqual(["int-42", "int-live"]);
    expect(interactions[1]).toMatchObject({ id: "int-live", sessionId: "main-bus", taskRunId: "run-wait" });
    expect(synced.at(-1).map((i) => i.id)).toEqual(["int-live"]);

    const { shouldSkipChatHistoryEntry } = require("../../../src/app/chat/historyStore");
    const { replayHistory } = require("../../../src/agents/runtime/context/replayHistory");
    expect(shouldSkipChatHistoryEntry("system", "Approve schema?\n\n/answer ui_abc123 <reply>")).toBe(true);
    expect(replayHistory([
      { type: "request.accepted", taskRunId: "t-dismissed", request: { text: "old prompt" } },
      { type: "task.cancelled", taskRunId: "t-dismissed", error: "interaction_dismissed" },
      { type: "request.accepted", taskRunId: "t-ok", request: { text: "real prompt" } },
      { type: "task.completed", taskRunId: "t-ok", result: { text: "real reply" } },
    ])).toEqual([
      { role: "user", content: "real prompt" },
      { role: "assistant", content: "real reply" },
    ]);
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

      // Absolute path inside .ufoo/ opens cleanly even when called with a worktreeRoot fallback
      const reportDir = path.join(tmp, ".ufoo", "context");
      const fakeWorktree = path.join(tmp, ".ufoo", "worktrees", "codex-wt");
      fs.mkdirSync(reportDir, { recursive: true });
      fs.mkdirSync(fakeWorktree, { recursive: true });
      const reportAbs = path.join(reportDir, "decision-memory-review.md");
      fs.writeFileSync(reportAbs, "# Decision Review\n\nAll 11 facts verified.\n", "utf8");
      const reportDoc = loadWorkspaceDocs(tmp, { filePath: reportAbs, worktreeRoot: fakeWorktree });
      expect(reportDoc.document.path).toBe(".ufoo/context/decision-memory-review.md");
      expect(reportDoc.document.language).toBe("markdown");
      expect(reportDoc.document.content).toContain("All 11 facts verified.");

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

      // Create 2 more open decisions to test tidy prompt, update_decision tool, delete, and clear
      const created2 = handleWorkspaceContext(tmp, {
        operation: "decision.create",
        title: "Temporary migration flag",
        decision: "Drop after rollout.",
      });
      const tempFile = created2.actionResult.file;
      const created3 = handleWorkspaceContext(tmp, {
        operation: "decision.create",
        title: "Keep daemon socket protocol stable",
        decision: "Use versioned IPC envelopes.",
      });
      const keepFile = created3.actionResult.file;

      const tidyPlan = buildDecisionTidyPrompt(tmp);
      expect(tidyPlan.openCount).toBe(2);
      expect(tidyPlan.files).toEqual(expect.arrayContaining([tempFile, keepFile]));
      expect(tidyPlan.prompt).toContain("update_decision");
      expect(tidyPlan.prompt).toContain("ask_user");
      expect(tidyPlan.prompt).toContain("remember");

      // Agent native update_decision tool archives stale decision cleanly
      const { updateDecisionHandler } = require("../../../src/tools/handlers/decisions");
      const toolRes = updateDecisionHandler(
        { projectRoot: tmp, subscriber: "ufoo-agent" },
        { file: tempFile, status: "archived", reason: "Rollout completed" }
      );
      expect(toolRes).toMatchObject({ ok: true, file: tempFile, status: "archived" });

      ctx = handleWorkspaceContext(tmp, { operation: "snapshot" });
      expect(ctx.openDecisionCount).toBe(1);
      expect(ctx.archivedDecisionCount).toBe(1);
      expect(ctx.decisions.find((d) => d.file === tempFile)?.resolution_note).toBe("Rollout completed");

      // Single delete removes only target file
      ctx = handleWorkspaceContext(tmp, { operation: "decision.delete", file: createdFile });
      expect(ctx.decisions.map((d) => d.file)).not.toContain(createdFile);
      expect(ctx.decisions).toHaveLength(2);

      // Clear closed removes archived/resolved while preserving open
      ctx = handleWorkspaceContext(tmp, { operation: "decision.clear", scope: "closed" });
      expect(ctx.decisions.map((d) => d.file)).toEqual([keepFile]);

      // Clear all empties decisions
      ctx = handleWorkspaceContext(tmp, { operation: "decision.clear", scope: "all" });
      expect(ctx.decisions).toHaveLength(0);
      expect(ctx.openDecisionCount).toBe(0);

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
  }, 15000);

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
  }, 15000);

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
            socket.write(`${JSON.stringify({
              type: "bus",
              data: {
                event: "message",
                publisher: "ufoo-agent",
                target: req.target,
                source: req.source || "",
                message: req.message || "",
              },
            })}\n`);
          } else if (req.type === "prompt") {
            socket.write(`${JSON.stringify({
              type: "runtime_event",
              data: {
                type: "task.started",
                agentId: "ufoo-agent",
                sessionId: "main-default",
                taskRunId: "run-1",
                sequence: 1,
              },
            })}\n`);
          }
        }
      });
    });
    await new Promise((resolve) => fakeDaemon.listen(daemonSock, resolve));

    const controllerDir = path.join(tmp, "controller");
    fs.mkdirSync(path.join(controllerDir, ".ufoo", "run"), { recursive: true });
    // Regression: an archived project deleted from disk must never crash startup
    fs.mkdirSync(path.join(controllerDir, ".ufoo", "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(controllerDir, ".ufoo", "ui", "desktop-archive.json"),
      JSON.stringify({ projects: [{ root: path.join(tmp, "deleted-folder-enoent") }], sessions: [] }),
      "utf8"
    );
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

      async function waitForEnvelope(matches, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
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

      // Query per-agent models & thinking levels + configure worker runtime
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "worker.models",
        requestId: "cmd-wmodels",
        payload: { agent_id: "ucode:a1b2c3d4" },
      })));
      const wModelsRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-wmodels", 9000);
      expect(wModelsRes?.payload?.ok).toBe(true);
      expect(Array.isArray(wModelsRes?.payload?.thinking_levels)).toBe(true);

      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "worker.configure",
        requestId: "cmd-wcfg",
        payload: {
          agent_id: "ucode:a1b2c3d4",
          model: "claude-sonnet-4-6",
          thinking_level: "high",
          permission_mode: "supervised",
        },
      })));
      const wCfgRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-wcfg");
      expect(wCfgRes?.payload?.ok).toBe(true);
      expect(wCfgRes?.payload?.model).toBe("claude-sonnet-4-6");
      expect(wCfgRes?.payload?.thinking_level).toBe("high");
      expect(wCfgRes?.payload?.permission_mode).toBe("supervised");
      const updatedFrame = envelopes.filter((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4").at(-1);
      expect(updatedFrame?.payload?.model).toBe("claude-sonnet-4-6");
      expect(updatedFrame?.payload?.thinking_level).toBe("high");
      expect(updatedFrame?.payload?.permission_mode).toBe("supervised");

      // Direct submit inside Worker Single View while worker is working queues cleanly
      // instead of injecting prematurely into transcript; send_now dispatches it and
      // never leaks into ufoo main transcript.
      const mainCountBeforeWorkerSend = envelopes.filter((e) => e.name === "transcript.append").length;
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "multi.raw",
        requestId: "cmd-wsend",
        payload: {
          agent_id: "ucode:a1b2c3d4",
          input: "hello ucode directly",
          cursor: 20,
          input_revision: 1,
          submit: true,
        },
      })));
      const wSendRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-wsend");
      expect(wSendRes?.payload?.ok).toBe(true);
      expect(wSendRes?.payload?.queued).toBe(true);
      const afterQueueFrame = envelopes.filter((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4").at(-1);
      expect(afterQueueFrame?.payload?.entries?.some((e) => e.kind === "user" && e.text === "hello ucode directly")).toBe(false);
      const qSnap = envelopes.filter((e) => e.name === "queue.snapshot").at(-1);
      expect(qSnap?.payload?.workers?.["ucode:a1b2c3d4"]?.items?.[0]?.text).toBe("hello ucode directly");

      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "queue.send_now",
        requestId: "cmd-wsend-now",
        payload: {
          scope: "worker",
          agent_id: "ucode:a1b2c3d4",
          id: wSendRes.payload.queue_id,
        },
      })));
      const wSendNowRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-wsend-now");
      expect(wSendNowRes?.payload?.ok).toBe(true);
      const afterSendFrame = envelopes.filter((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4").at(-1);
      expect(afterSendFrame?.payload?.entries?.some((e) => e.kind === "user" && e.text === "hello ucode directly")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const leakedMain = envelopes.slice(mainCountBeforeWorkerSend).filter(
        (e) => e.name === "transcript.append" && String(e.payload?.text || "").includes("hello ucode directly")
      );
      expect(leakedMain).toHaveLength(0);

      // Seed disk agent metadata so worker.configure persists and survives subsequent thin daemon STATUS refreshes
      const agentsFile = path.join(projectDir, ".ufoo", "agent", "all-agents.json");
      fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
      fs.writeFileSync(agentsFile, JSON.stringify({
        schema_version: 1,
        agents: {
          "ucode:a1b2c3d4": {
            agent_type: "ucode",
            nickname: "ucode-1",
            status: "active",
            launch_mode: "internal",
            provider_session_id: "ucode-sess-a1b2c3d4",
            model: "gpt-6.1-sol",
            thinking_level: "medium",
            permission_mode: "auto_edit",
          },
        },
      }), "utf8");

      const frameCountBeforeConfigure = envelopes.length;
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "worker.configure",
        requestId: "cmd-wcfg-persist",
        payload: { agent_id: "ucode:a1b2c3d4", model: "gpt-6.2-sol", thinking_level: "high" },
      })));
      const wCfgPersistRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-wcfg-persist");
      expect(wCfgPersistRes?.payload).toMatchObject({ ok: true, model: "gpt-6.2-sol", thinking_level: "high" });
      const configuredFrame = envelopes.slice(frameCountBeforeConfigure)
        .filter((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4")
        .at(-1);
      expect(configuredFrame?.payload).toMatchObject({ model: "gpt-6.2-sol", thinking_level: "high" });

      // Trigger a thin daemon STATUS push (fakeDaemon omits model/thinking_level from active_meta)
      // and verify the worker's configured model is NOT reverted to default.
      const beforeStatusRefresh = envelopes.length;
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "multi.raw",
        requestId: "cmd-trigger-status",
        payload: { agent_id: "ucode:a1b2c3d4", input: "status ping", submit: true, force_send: true },
      })));
      await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-trigger-status");
      await waitForEnvelope((e, idx) => idx >= beforeStatusRefresh && e.name === "agents.snapshot");
      const frameAfterStatus = envelopes
        .filter((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4")
        .at(-1);
      expect(frameAfterStatus?.payload).toMatchObject({ model: "gpt-6.2-sol", thinking_level: "high" });
      const treeAfterStatus = envelopes.filter((e) => e.name === "projects.tree").at(-1)?.payload;
      const workerRowAfterStatus = treeAfterStatus?.projects
        ?.find((p) => p.root === fs.realpathSync(projectDir))
        ?.workers?.find((w) => w.id === "ucode:a1b2c3d4");
      expect(workerRowAfterStatus).toMatchObject({ model: "gpt-6.2-sol", thinking_level: "high" });

      // Clear internal worker & clear ufoo main conversation
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "worker.clear",
        requestId: "cmd-wclear",
        payload: { agent_id: "ucode:a1b2c3d4" },
      })));
      const wClearRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-wclear");
      expect(wClearRes?.payload?.ok).toBe(true);
      const clearedFrame = envelopes.filter((e) => e.name === "worker.view.frame" && e.payload.agent_id === "ucode:a1b2c3d4").at(-1);
      expect(clearedFrame?.payload?.entries).toEqual([]);

      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "chat.clear",
        requestId: "cmd-cclear",
        payload: {},
      })));
      const cClearRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-cclear");
      expect(cClearRes?.payload?.ok).toBe(true);
      expect(String(cClearRes?.payload?.conversation_id || "")).toMatch(/^main-/);
      expect(envelopes.some((e) => e.name === "transcript.reset" && Array.isArray(e.payload.entries) && e.payload.entries.length === 0)).toBe(true);

      const latestTree = () => envelopes.filter((e) => e.name === "projects.tree").at(-1).payload;
      let archiveSeq = 0;
      const archiveCommand = async (name, payload) => {
        const reqId = `${name}-${++archiveSeq}`;
        client.write(encodeMessage(createEnvelope({ kind: "command", name, requestId: reqId, payload })));
        const result = await waitForEnvelope((e) => e.kind === "result" && e.request_id === reqId);
        expect(result.payload).toMatchObject({ ok: true });
      };
      const root = fs.realpathSync(projectDir);
      // Rename & Pin before Archive / Unarchive / Delete
      await archiveCommand("session.rename", { root, session_id: "cursor:99887766", label: "Auth Review" });
      expect(latestTree().projects.find((p) => p.root === root).workers.find((w) => w.id === "cursor:99887766")?.label).toBe("Auth Review");

      await archiveCommand("session.pin", { root, session_id: "cursor:99887766", pinned: true });
      const pinnedWorkers = latestTree().projects.find((p) => p.root === root).workers;
      expect(pinnedWorkers[0].id).toBe("cursor:99887766");
      expect(pinnedWorkers[0].pinned).toBe(true);

      // Simulate a new saved turn on ucode:a1b2c3d4 after worker.clear so archiving preserves it as recoverable
      const agentsData = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
      agentsData.agents["ucode:a1b2c3d4"].provider_session_id = "ucode-sess-after-clear";
      fs.writeFileSync(agentsFile, JSON.stringify(agentsData), "utf8");

      await archiveCommand("session.archive", { root, session_id: "ucode:a1b2c3d4" });
      expect(latestTree().stage_target.kind).toBe("project_main");

      // Submitting to ufoo main immediately enters busy loading state
      const statusCountBeforeMain = envelopes.filter((e) => e.name === "status.set").length;
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "input.submit",
        requestId: "cmd-main-prompt",
        payload: { text: "check status", target_agent: "", input_target: "main" },
      })));
      const mainSubmitRes = await waitForEnvelope((e) => e.kind === "result" && e.request_id === "cmd-main-prompt");
      expect(mainSubmitRes?.payload?.ok).toBe(true);
      const busyStatusEvents = envelopes.filter((e) => e.name === "status.set").slice(statusCountBeforeMain);
      expect(busyStatusEvents.some((e) => e.payload?.busy === true)).toBe(true);
      expect(latestTree().projects.find((p) => p.root === root).workers.map((w) => w.id)).not.toContain("ucode:a1b2c3d4");
      expect(latestTree().projects.find((p) => p.root === root).archived.map((a) => a.id)).toContain("ucode:a1b2c3d4");

      await archiveCommand("session.unarchive", { root, session_id: "ucode:a1b2c3d4", resume: false });
      expect(latestTree().projects.find((p) => p.root === root).archived.map((a) => a.id)).not.toContain("ucode:a1b2c3d4");

      await archiveCommand("session.delete", { root, session_id: "ucode:a1b2c3d4" });
      expect(latestTree().projects.find((p) => p.root === root).workers.map((w) => w.id)).not.toContain("ucode:a1b2c3d4");
      expect(latestTree().projects.find((p) => p.root === root).archived.map((a) => a.id)).not.toContain("ucode:a1b2c3d4");

      // Archiving an unrecoverable session (no provider_session_id) hides it without leaving a dead entry in archived
      await archiveCommand("session.archive", { root, session_id: "cursor:99887766" });
      expect(latestTree().projects.find((p) => p.root === root).workers.map((w) => w.id)).not.toContain("cursor:99887766");
      expect(latestTree().projects.find((p) => p.root === root).archived.map((a) => a.id)).not.toContain("cursor:99887766");

      await archiveCommand("project.archive", { root });
      expect(latestTree().scope).toBe("controller");
      expect(latestTree().projects.some((p) => p.root === root)).toBe(false);

      await archiveCommand("project.add", { root });
      expect(latestTree().projects.some((p) => p.root === root)).toBe(true);

      // Switching to another project with agent_id: "main" must land directly on project_main on first click
      const secondProjectDir = path.join(tmp, "second-proj");
      fs.mkdirSync(secondProjectDir, { recursive: true });
      const secondRoot = fs.realpathSync(secondProjectDir);
      const beforeCount = envelopes.length;
      await archiveCommand("worker.focus_view", { root: secondRoot, agent_id: "main" });
      const afterEvents = envelopes.slice(beforeCount);
      const switchedSnap = [...afterEvents].reverse().find((m) => m.name === "app.snapshot");
      expect(switchedSnap).toBeTruthy();
      expect(switchedSnap.payload.active_root).toBe(secondRoot);
      expect(switchedSnap.payload.stage_target).toEqual({ kind: "project_main", agentId: "" });
      expect(afterEvents.some((m) => m.name === "worker.view.frame" && m.payload?.agent_id === "main")).toBe(false);

      client.destroy();
    } finally {
      if (prevControllerEnv === undefined) delete process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
      else process.env.UFOO_GLOBAL_CONTROLLER_ROOT = prevControllerEnv;
      if (hostHandle) await hostHandle.close();
      await new Promise((resolve) => fakeDaemon.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test("taskControl configure RPC and SDK threads support live model, thinking, and permission updates", async () => {
    const tmp = makeTempDir("ufoo-wctl-");
    const { startTaskControlServer, configureInternalAgent, clearInternalAgent } = require("../../../src/agents/internal/taskControl");
    const { CodexSdkThread } = require("../../../src/agents/providers/codexThreadProvider");
    const { ClaudeApiThread } = require("../../../src/agents/providers/claudeThreadProvider");
    const { getUfooPaths } = require("../../../src/coordination/state/paths");

    const ufooPaths = getUfooPaths(tmp);
    fs.mkdirSync(path.dirname(ufooPaths.agentsFile), { recursive: true });
    fs.writeFileSync(ufooPaths.agentsFile, JSON.stringify({
      agents: {
        "claude:test1": {
          status: "active",
          pid: process.pid,
          agent_type: "claude",
          launch_mode: "internal",
        },
      },
    }), "utf8");

    const applied = [];
    let clearedCount = 0;
    const server = await startTaskControlServer(tmp, "claude:test1", {
      cancel: () => ({ ok: true, cancelled: false }),
      async configure(patch) {
        applied.push(patch);
        return { ok: true, ...patch };
      },
      async clear() {
        clearedCount += 1;
        return { ok: true, cleared: true, cleared_surface: true };
      },
    });
    try {
      const res = await configureInternalAgent(tmp, "claude:test1", {
        model: "claude-opus-4-6",
        thinking_level: "max",
        permission_mode: "full_access",
      });
      expect(res).toMatchObject({ ok: true, model: "claude-opus-4-6", thinking_level: "max", permission_mode: "full_access" });
      expect(applied).toHaveLength(1);

      const clearRes = await clearInternalAgent(tmp, "claude:test1");
      expect(clearRes).toMatchObject({ ok: true, cleared: true, cleared_surface: true });
      expect(clearedCount).toBe(1);

      const codexThread = new CodexSdkThread({ model: "gpt-5-codex", permissionMode: "auto_edit" });
      codexThread.sdkThread = { fake: true };
      const codexRes = codexThread.configure({ model: "gpt-5.4", thinkingLevel: "xhigh", permissionMode: "supervised" });
      expect(codexRes).toEqual({ model: "gpt-5.4", thinkingLevel: "xhigh", permissionMode: "supervised" });
      expect(codexThread.sdkThread).toBeNull();

      const claudeThread = new ClaudeApiThread({ model: "claude-sonnet-4-6", permissionMode: "auto_edit" });
      const claudeRes = claudeThread.configure({ model: "claude-opus-4-6", thinkingLevel: "high", permissionMode: "full_access" });
      expect(claudeRes).toEqual({ model: "claude-opus-4-6", thinkingLevel: "high", permissionMode: "full_access" });
      expect(claudeThread.agentOptions.effort).toBe("high");
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test("resolves historical inactive speaker brands and strips redundant provider activity_detail subtitles", () => {
    const {
      buildProjectSpeakerIndex,
      rawHistoryToEntries,
      sanitizeUiActivityDetail,
    } = require("../../../src/ui/desktopUiHost");
    const tmp = makeTempDir("ufoo-speaker-");
    const projectDir = path.join(tmp, "Neptune");
    fs.mkdirSync(path.join(projectDir, ".ufoo", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        schema_version: 1,
        agents: {
          "codex:db12e17d": {
            agent_type: "codex",
            nickname: "neptune-architect",
            scoped_nickname: "neptune-architect",
            status: "inactive",
            group_member_id: "architect",
            last_seen: "2026-11-26T15:08:54.125Z",
          },
        },
      }),
      "utf8"
    );
    try {
      const index = buildProjectSpeakerIndex(projectDir);
      const entries = rawHistoryToEntries(
        [{ type: "system", text: "architect · 复核新增最高风险", meta: { speaker: "" } }],
        index
      );
      expect(entries[0]).toMatchObject({
        sender_id: "codex:db12e17d",
        sender_type: "codex",
      });

      expect(sanitizeUiActivityDetail("agy-cli")).toBe("");
      expect(sanitizeUiActivityDetail("codex-cli")).toBe("");
      expect(sanitizeUiActivityDetail("claude-cli")).toBe("");
      expect(sanitizeUiActivityDetail("ucode")).toBe("");
      expect(sanitizeUiActivityDetail("runner")).toBe("");
      expect(sanitizeUiActivityDetail("Editing cache.js")).toBe("Editing cache.js");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("session.delete preserves worktrees shared by other group members and workspace.worktree.remove refuses active/dirty worktrees", async () => {
    const { spawnSync } = require("child_process");
    const tmp = makeTempDir("ufoo-shared-wt-");
    const projectDir = path.join(tmp, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    const git = (cwd, args) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git(projectDir, ["init"]);
    git(projectDir, ["config", "user.email", "test@ufoo.dev"]);
    git(projectDir, ["config", "user.name", "ufoo test"]);
    fs.writeFileSync(path.join(projectDir, "a.txt"), "hello\n", "utf8");
    git(projectDir, ["add", "a.txt"]);
    git(projectDir, ["commit", "-m", "init"]);

    const sharedWt = path.join(projectDir, ".ufoo", "worktrees", "group-shared");
    fs.mkdirSync(path.dirname(sharedWt), { recursive: true });
    git(projectDir, ["worktree", "add", "-b", "ufoo/group-shared", sharedWt, "HEAD"]);

    const agentsFile = path.join(projectDir, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(agentsFile, JSON.stringify({
      schema_version: 1,
      agents: {
        "codex:m1": {
          agent_type: "codex",
          nickname: "architect",
          status: "inactive",
          launch_mode: "internal",
          worktree_root: sharedWt,
          worktree_branch: "ufoo/group-shared",
          group_id: "g1",
        },
        "codex:m2": {
          agent_type: "codex",
          nickname: "builder",
          status: "active",
          pid: process.pid,
          launch_mode: "internal",
          worktree_root: sharedWt,
          worktree_branch: "ufoo/group-shared",
          group_id: "g1",
        },
      },
    }), "utf8");

    const daemonSock = path.join(tmp, "ufoo.sock");
    const fakeDaemon = net.createServer((socket) => {
      socket.on("error", () => {});
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
                projectRoot: projectDir,
                active: ["codex:m2"],
                active_meta: [{
                  id: "codex:m2",
                  nickname: "builder",
                  agent_type: "codex",
                  launch_mode: "internal",
                  worktree_root: sharedWt,
                  worktree_branch: "ufoo/group-shared",
                  group_id: "g1",
                }],
              },
            })}\n`);
          } else if (req.type === "list_recoverable_agents") {
            socket.write(`${JSON.stringify({ type: "response", data: { recoverable: { recoverable: [], groups: [] } } })}\n`);
          }
        }
      });
    });
    await new Promise((resolve) => fakeDaemon.listen(daemonSock, resolve));

    const controllerDir = path.join(tmp, "controller");
    fs.mkdirSync(path.join(controllerDir, ".ufoo", "run"), { recursive: true });
    fs.symlinkSync(daemonSock, path.join(controllerDir, ".ufoo", "run", "ufoo.sock"));
    const prevControllerEnv = process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
    process.env.UFOO_GLOBAL_CONTROLLER_ROOT = controllerDir;
    const uiSock = path.join(tmp, "ui.sock");
    const handoffSock = path.join(tmp, "handoff.sock");
    let hostHandle = null;
    try {
      hostHandle = await startDesktopUiHost({
        controllerRoot: controllerDir,
        initialProjectRoot: projectDir,
        socketPath: uiSock,
        authToken: "wt-secret",
        handoffSocketPath: handoffSock,
        isRunning: () => true,
        startDaemon: () => {},
      });
      const client = net.createConnection(uiSock);
      await new Promise((resolve) => client.once("connect", resolve));
      const envelopes = [];
      let rawBuf = "";
      client.on("data", (chunk) => {
        rawBuf += chunk.toString("utf8");
        const lines = rawBuf.split("\n");
        rawBuf = lines.pop() || "";
        for (const line of lines.filter(Boolean)) envelopes.push(JSON.parse(line));
      });
      const waitFor = (pred, timeoutMs = 4000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          const hit = envelopes.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
          setTimeout(tick, 20);
        };
        tick();
      });
      client.write(encodeMessage(createEnvelope({ kind: "hello", name: "hello", payload: { auth_token: "wt-secret" } })));
      await waitFor((e) => e.kind === "welcome");

      // Deleting codex:m1 must NOT remove sharedWt because codex:m2 still uses it
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "session.delete",
        requestId: "cmd-del-m1",
        payload: { root: projectDir, session_id: "codex:m1" },
      })));
      const delRes = await waitFor((e) => e.kind === "result" && e.request_id === "cmd-del-m1");
      expect(delRes.payload.ok).toBe(true);
      expect(delRes.payload.worktree_removed).toBe(false);
      expect(delRes.payload.worktree_shared_by).toContain("builder");
      expect(fs.existsSync(sharedWt)).toBe(true);

      // Direct workspace.worktree.remove must refuse while codex:m2 is active
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "workspace.worktree.remove",
        requestId: "cmd-rm-inuse",
        payload: { projectRoot: projectDir, worktreePath: sharedWt, force: true },
      })));
      const inUseRes = await waitFor((e) => e.kind === "result" && e.request_id === "cmd-rm-inuse");
      expect(inUseRes.payload.ok).toBe(false);
      expect(inUseRes.payload.in_use).toBe(true);
      expect(fs.existsSync(sharedWt)).toBe(true);

      client.destroy();
    } finally {
      if (prevControllerEnv === undefined) delete process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
      else process.env.UFOO_GLOBAL_CONTROLLER_ROOT = prevControllerEnv;
      if (hostHandle) await hostHandle.close();
      await new Promise((resolve) => fakeDaemon.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test("rawHistoryToEntries strips @target from direct user sends, populates target metadata, and deduplicates legacy ufoo bus echo", () => {
    const { rawHistoryToEntries } = require("../../../src/ui/desktopUiHost");
    const speakerIndex = new Map([
      ["ufoo", { id: "ufoo-agent", type: "ufoo" }],
      ["ucode-5", { id: "ucode:5", type: "ucode", label: "ucode-5" }],
      ["ucode:5", { id: "ucode:5", type: "ucode", label: "ucode-5" }],
    ]);

    const entries = rawHistoryToEntries([
      { kind: "user", text: "› @ucode-5 再试下 应该可以读了" },
      { kind: "bus", text: "ufoo · 再试下 应该可以读了" },
      { kind: "user", text: "› @Override is a Kotlin annotation" },
    ], speakerIndex);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "user",
      text: "再试下 应该可以读了",
      target_id: "ucode:5",
      target_label: "ucode-5",
      target_type: "ucode",
    });
    expect(entries[1]).toMatchObject({
      kind: "user",
      text: "› @Override is a Kotlin annotation",
    });
    expect(entries[1].target_label).toBeUndefined();
  });

  test("queues follow-ups while main ufoo is busy instead of injecting into transcript, supports remove/clear, and auto-drains on task.completed", async () => {
    const tmp = makeTempDir("ufoo-queue-host-");
    const controllerDir = path.join(tmp, "controller");
    const projectDir = path.join(tmp, "demo-proj");
    fs.mkdirSync(controllerDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const uiSock = path.join(tmp, "ui.sock");
    const handoffSock = path.join(tmp, "handoff.sock");
    const daemonSock = path.join(tmp, "daemon.sock");
    const daemonSockets = new Set();
    const receivedPrompts = [];

    const fakeDaemon = net.createServer((sock) => {
      daemonSockets.add(sock);
      sock.on("error", error => {
        if (!["EPIPE", "ECONNRESET"].includes(error.code)) throw error;
      });
      sock.on("close", () => daemonSockets.delete(sock));
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          const req = JSON.parse(line);
          if (req.type === "status") {
            sock.write(`${JSON.stringify({
              type: "status",
              data: { agents: {}, activeCount: 0, cron: { tasks: [] } },
            })}\n`);
          } else if (req.type === "prompt") {
            receivedPrompts.push(req);
            const runId = `run-${receivedPrompts.length}`;
            sock.write(`${JSON.stringify({
              type: "runtime_event",
              data: {
                type: "task.started",
                agentId: "ufoo-agent",
                projectRoot: projectDir,
                sessionId: "main-default",
                sequence: receivedPrompts.length * 10 + 1,
                taskRunId: runId,
              },
            })}\n`);
          }
        }
      });
    });
    await new Promise((resolve) => fakeDaemon.listen(daemonSock, resolve));

    const prevControllerEnv = process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
    process.env.UFOO_GLOBAL_CONTROLLER_ROOT = controllerDir;
    let hostHandle = null;
    try {
      fs.mkdirSync(path.join(controllerDir, ".ufoo", "run"), { recursive: true });
      fs.symlinkSync(daemonSock, path.join(controllerDir, ".ufoo", "run", "ufoo.sock"));

      hostHandle = await startDesktopUiHost({
        controllerRoot: controllerDir,
        initialProjectRoot: projectDir,
        socketPath: uiSock,
        authToken: "queue-secret",
        handoffSocketPath: handoffSock,
        isRunning: () => true,
        stopDaemon: () => {},
        startDaemon: () => {},
      });

      const client = net.createConnection(uiSock);
      await new Promise((resolve) => client.once("connect", resolve));
      const envelopes = [];
      let rawBuf = "";
      client.on("data", (chunk) => {
        rawBuf += chunk.toString("utf8");
        const lines = rawBuf.split("\n");
        rawBuf = lines.pop() || "";
        for (const line of lines.filter(Boolean)) envelopes.push(JSON.parse(line));
      });
      const waitFor = (pred, timeoutMs = 4000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          const hit = envelopes.find(pred);
          if (hit) return resolve(hit);
          if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
          setTimeout(tick, 20);
        };
        tick();
      });

      client.write(encodeMessage(createEnvelope({ kind: "hello", name: "hello", payload: { auth_token: "queue-secret" } })));
      await waitFor((e) => e.kind === "welcome");

      // Select demo project
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "project.select",
        requestId: "sel-1",
        payload: { root: projectDir },
      })));
      await waitFor((e) => e.kind === "result" && e.request_id === "sel-1");

      // 1. First prompt dispatches immediately while idle
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "input.submit",
        requestId: "sub-1",
        payload: { text: "First task" },
      })));
      const res1 = await waitFor((e) => e.kind === "result" && e.request_id === "sub-1");
      expect(res1.payload.routed).toBe("submit");
      await waitFor(() => receivedPrompts.length === 1);

      // 2. Follow-ups while busy MUST queue instead of injecting into transcript or dispatching PROMPT
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "input.submit",
        requestId: "sub-2",
        payload: { text: "Queued second" },
      })));
      const res2 = await waitFor((e) => e.kind === "result" && e.request_id === "sub-2");
      expect(res2.payload.routed).toBe("queued");
      expect(res2.payload.queued).toBe(true);

      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "input.submit",
        requestId: "sub-3",
        payload: { text: "Queued third" },
      })));
      const res3 = await waitFor((e) => e.kind === "result" && e.request_id === "sub-3");
      expect(res3.payload.routed).toBe("queued");

      expect(receivedPrompts).toHaveLength(1);
      const userTranscriptsBefore = envelopes.filter(
        (e) => e.name === "transcript.append" && e.payload?.kind === "user"
      );
      expect(userTranscriptsBefore.some((e) => e.payload.text.includes("Queued second"))).toBe(false);
      expect(userTranscriptsBefore.some((e) => e.payload.text.includes("Queued third"))).toBe(false);

      // 3. Remove "Queued second" cleanly (Edit/Remove flow)
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "queue.remove",
        requestId: "rm-2",
        payload: { scope: "main", id: res2.payload.queue_id },
      })));
      const rmRes = await waitFor((e) => e.kind === "result" && e.request_id === "rm-2");
      expect(rmRes.payload.ok).toBe(true);
      expect(rmRes.payload.removed?.text).toBe("Queued second");

      // 4. Completing turn 1 automatically drains "Queued third" into PROMPT and transcript
      for (const sock of daemonSockets) {
        sock.write(`${JSON.stringify({
          type: "runtime_event",
          data: {
            type: "task.completed",
            agentId: "ufoo-agent",
            projectRoot: projectDir,
            sessionId: "main-default",
            sequence: 15,
            taskRunId: "run-1",
            result: { text: "First done" },
          },
        })}\n`);
      }

      await waitFor(() => receivedPrompts.length === 2, 4000);
      expect(receivedPrompts[1].text).toBe("Queued third");
      const drainedTranscript = await waitFor(
        (e) => e.name === "transcript.append" && e.payload?.kind === "user" && e.payload.text.includes("Queued third"),
        4000
      );
      expect(drainedTranscript).toBeTruthy();

      client.destroy();
    } finally {
      if (prevControllerEnv === undefined) delete process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
      else process.env.UFOO_GLOBAL_CONTROLLER_ROOT = prevControllerEnv;
      if (hostHandle) await hostHandle.close();
      await new Promise((resolve) => fakeDaemon.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test("switching projects never blanks live workers even if daemon STATUS is delayed", async () => {
    const tmp = makeTempDir("ufoo-dswitch-");
    const projectA = path.join(tmp, "proj-a");
    const projectB = path.join(tmp, "proj-b");
    fs.mkdirSync(path.join(projectA, ".ufoo", "agent"), { recursive: true });
    fs.mkdirSync(path.join(projectB, ".ufoo", "agent"), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".ufoo", "agent", "all-agents.json"), JSON.stringify({
      schema_version: 1,
      agents: {},
    }), "utf8");
    fs.writeFileSync(path.join(projectB, ".ufoo", "agent", "all-agents.json"), JSON.stringify({
      schema_version: 1,
      agents: {
        "ucode:7988e2ff": {
          agent_type: "ucode",
          nickname: "ucode-3",
          status: "active",
          launch_mode: "internal",
          pid: process.pid,
          activity_state: "working",
        },
      },
    }), "utf8");

    const daemonSock = path.join(tmp, "daemon.sock");
    const pendingTimers = new Set();
    const realB = fs.realpathSync(projectB);
    const fakeDaemon = net.createServer((socket) => {
      socket.on("error", () => {});
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          if (req.type === "status") {
            const targetRoot = req.project_root || projectA;
            // Deliberately delay STATUS for projectB (simulating a busy daemon)
            const delayMs = targetRoot === realB ? 350 : 0;
            const timer = setTimeout(() => {
              pendingTimers.delete(timer);
              if (socket.destroyed || !socket.writable) return;
              const isB = targetRoot === realB;
              try {
                socket.write(`${JSON.stringify({
                  type: "status",
                  data: {
                    projectRoot: targetRoot,
                    active: isB ? ["ucode:7988e2ff"] : [],
                    active_meta: isB
                      ? [{
                          id: "ucode:7988e2ff",
                          nickname: "ucode-3",
                          agent_type: "ucode",
                          launch_mode: "internal",
                          activity_state: "working",
                        }]
                      : [],
                  },
                })}\n`);
              } catch {
                // ignore closed test socket
              }
            }, delayMs);
            pendingTimers.add(timer);
          } else if (req.type === "list_recoverable_agents") {
            try {
              socket.write(`${JSON.stringify({
                type: "response",
                data: { recoverable: { recoverable: [], groups: [] } },
              })}\n`);
            } catch {
              // ignore closed test socket
            }
          }
        }
      });
    });
    await new Promise((resolve) => fakeDaemon.listen(daemonSock, resolve));

    const controllerDir = path.join(tmp, "controller");
    fs.mkdirSync(path.join(controllerDir, ".ufoo", "run"), { recursive: true });
    fs.symlinkSync(daemonSock, path.join(controllerDir, ".ufoo", "run", "ufoo.sock"));
    const uiSock = path.join(tmp, "ui.sock");
    const prevControllerEnv = process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
    process.env.UFOO_GLOBAL_CONTROLLER_ROOT = controllerDir;

    let hostHandle = null;
    try {
      hostHandle = await startDesktopUiHost({
        controllerRoot: controllerDir,
        initialProjectRoot: projectA,
        socketPath: uiSock,
        authToken: "switch-token-1234",
        enableHandoffServer: false,
        enableRemoteBridge: false,
        isRunning: () => true,
        startDaemon: () => {},
      });

      const envelopes = [];
      const client = net.createConnection(uiSock);
      await new Promise((resolve) => client.once("connect", resolve));
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
      const waitFor = async (pred, timeoutMs = 3000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const hit = envelopes.find(pred);
          if (hit) return hit;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Timed out waiting for envelope");
      };

      client.write(encodeMessage(createEnvelope({
        kind: "hello",
        payload: { auth_token: "switch-token-1234", capabilities: [DESKTOP_HOST_CAPABILITY] },
      })));
      await waitFor((e) => e.name === "projects.tree");

      const startIdx = envelopes.length;
      client.write(encodeMessage(createEnvelope({
        kind: "command",
        name: "worker.focus_view",
        requestId: "switch-b",
        payload: { root: realB, agent_id: "ucode:7988e2ff" },
      })));
      const swRes = await waitFor((e) => e.kind === "result" && e.request_id === "switch-b");
      expect(swRes.payload.ok).toBe(true);

      // Wait until the delayed STATUS also arrives
      await new Promise((resolve) => setTimeout(resolve, 500));

      const treeEventsAfterSwitch = envelopes
        .slice(startIdx)
        .filter((e) => e.name === "projects.tree" || e.name === "app.snapshot");
      expect(treeEventsAfterSwitch.length).toBeGreaterThan(0);

      // Every single snapshot/tree emitted during and after the switch MUST include ucode:7988e2ff (zero flicker!)
      for (const env of treeEventsAfterSwitch) {
        const nodeB = (env.payload?.projects || []).find((p) => p.root === realB);
        expect(nodeB).toBeTruthy();
        expect((nodeB.workers || []).map((w) => w.id)).toContain("ucode:7988e2ff");
      }

      client.destroy();
    } finally {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      if (prevControllerEnv === undefined) delete process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
      else process.env.UFOO_GLOBAL_CONTROLLER_ROOT = prevControllerEnv;
      if (hostHandle) await hostHandle.close();
      await new Promise((resolve) => fakeDaemon.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);

  test("resumed internal worker replays prior subscriber lineage history via previous_subscriber_ids and ucode runtime log", async () => {
    const tmp = makeTempDir("ufoo-lineage-");
    const { getUfooPaths } = require("../../../src/coordination/state/paths");
    const { resolveAgentLineageIds, readAgentSurfaceEvents } = require("../../../src/coordination/history/agentSurface");
    const { createAgentSurface } = require("../../../src/ui/agentSurface");

    try {
      const paths = getUfooPaths(tmp);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.mkdirSync(paths.busEventsDir, { recursive: true });
      const runtimeDir = path.join(paths.ufooDir, "agent", "ucode", "runtimes", "ucode-sess-1");
      fs.mkdirSync(runtimeDir, { recursive: true });

      // Resumed worker metadata with new subscriber_id but same provider_session_id
      fs.writeFileSync(paths.agentsFile, JSON.stringify({
        agents: {
          "ucode:new11111": {
            status: "active",
            pid: process.pid,
            agent_type: "ucode",
            nickname: "ucode-3",
            launch_mode: "internal",
            provider_session_id: "ucode-sess-1",
            previous_subscriber_id: "ucode:mid22222",
            previous_subscriber_ids: ["ucode:mid22222"],
          },
        },
      }), "utf8");

      // Earlier subscriber ID recorded in durable ucode runtime events.jsonl
      fs.writeFileSync(
        path.join(runtimeDir, "events.jsonl"),
        JSON.stringify({ agentId: "ucode:old00000", sessionId: "ucode-sess-1", type: "turn.started" }) + "\n",
        "utf8",
      );

      // Historical agent_surface events published under prior subscriber IDs
      const dayFile = path.join(paths.busEventsDir, "2026-11-27.jsonl");
      fs.writeFileSync(dayFile, [
        JSON.stringify({
          seq: 10,
          event: "agent_surface",
          publisher: "ucode:old00000",
          data: { subscriber: "ucode:old00000", surface: { type: "task_started", task_id: "t1", message: "Audit F04" } },
        }),
        JSON.stringify({
          seq: 11,
          event: "agent_surface",
          publisher: "ucode:mid22222",
          data: { subscriber: "ucode:mid22222", surface: { type: "text_delta", delta: "F04 fixed and verified." } },
        }),
      ].join("\n") + "\n", "utf8");

      const lineage = resolveAgentLineageIds(tmp, "ucode:new11111");
      expect(lineage).toEqual(expect.arrayContaining(["ucode:new11111", "ucode:mid22222", "ucode:old00000"]));

      const events = readAgentSurfaceEvents(tmp, lineage);
      expect(events).toHaveLength(2);
      const surface = createAgentSurface({ rawMarkdown: true });
      for (const evt of events) surface.accept(evt.data.surface);
      const snap = surface.snapshot();
      expect(snap.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
      expect(snap.entries[0].text).toContain("Audit F04");
      expect(snap.entries[1].text).toContain("F04 fixed and verified.");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
