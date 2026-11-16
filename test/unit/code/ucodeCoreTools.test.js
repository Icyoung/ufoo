const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  runReadTool,
  runWriteTool,
  runEditTool,
  runBashTool,
  runBashToolAsync,
  runToolCall,
} = require("../../../src/code");
const { MAX_FULL_READ_BYTES } = require("../../../src/code/tools/read");
const { getReadToolDescription } = require("../../../src/agents/prompts/native/toolDescriptions/read");
const { getEditToolDescription } = require("../../../src/agents/prompts/native/toolDescriptions/edit");
const { getBashToolDescription } = require("../../../src/agents/prompts/native/toolDescriptions/bash");

async function waitForBackgroundLog(execute, initial, marker) {
  const deadline = Date.now() + 3000;
  let result = initial;
  let output = initial.logOutput || "";
  while (result.running && !output.includes(marker) && Date.now() < deadline) {
    result = await execute({
      action: "logs",
      backgroundId: initial.backgroundId,
      offset: result.nextOffset,
      waitMs: 200,
    });
    expect(result.ok).toBe(true);
    output += result.logOutput || "";
  }
  expect(output).toContain(marker);
  return result;
}

describe("ucode-core tool kernel", () => {
  test("read returns selected line range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-read-"));
    const file = path.join(root, "a.txt");
    fs.writeFileSync(file, "l1\nl2\nl3\nl4\n", "utf8");

    const result = runReadTool({
      path: "a.txt",
      startLine: 2,
      endLine: 3,
    }, {
      workspaceRoot: root,
    });

    expect(result.ok).toBe(true);
    expect(result.content).toBe("l2\nl3");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("write then edit updates file content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-edit-"));
    const write = runWriteTool({
      path: "docs/note.md",
      content: "hello world\n",
    }, {
      workspaceRoot: root,
    });
    expect(write.ok).toBe(true);

    const edit = runEditTool({
      path: "docs/note.md",
      find: "hello",
      replace: "hi",
    }, {
      workspaceRoot: root,
    });
    expect(edit.ok).toBe(true);
    expect(edit.replacements).toBe(1);

    const raw = fs.readFileSync(path.join(root, "docs", "note.md"), "utf8");
    expect(raw).toBe("hi world\n");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("bash executes command in workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-bash-"));
    const result = runBashTool({
      command: "node -e \"process.stdout.write('ok')\"",
    }, {
      workspaceRoot: root,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("ok");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("dispatch rejects unknown tool", () => {
    const result = runToolCall({
      tool: "unknown",
      args: {},
    }, {
      workspaceRoot: "/tmp",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
    expect(result.supported_tools).toEqual([
      "read",
      "read_image",
      "write",
      "edit",
      "bash",
      "artifact_read",
      "plan_graph",
      "task_run",
      "ask_user",
    ]);
  });

  test("edit returns error when find pattern is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-edit-nofind-"));
    runWriteTool({ path: "test.txt", content: "hello" }, { workspaceRoot: root });
    const result = runEditTool({ path: "test.txt", find: "", replace: "x" }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("find pattern");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("edit replaceAll replaces multiple occurrences", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-edit-all-"));
    runWriteTool({ path: "test.txt", content: "aaa bbb aaa" }, { workspaceRoot: root });
    const result = runEditTool(
      { path: "test.txt", find: "aaa", replace: "ccc", all: true },
      { workspaceRoot: root }
    );
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(2);
    expect(fs.readFileSync(path.join(root, "test.txt"), "utf8")).toBe("ccc bbb ccc");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("edit returns ok=false with a not-found error when find misses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-edit-nochange-"));
    runWriteTool({ path: "test.txt", content: "hello" }, { workspaceRoot: root });
    const result = runEditTool({ path: "test.txt", find: "xyz", replace: "abc" }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.replacements).toBe(0);
    expect(result.error).toContain("not found");
    expect(result.error).toContain(path.join(root, "test.txt"));
    expect(fs.readFileSync(path.join(root, "test.txt"), "utf8")).toBe("hello");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("edit returns error for nonexistent file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-edit-nofile-"));
    const result = runEditTool({ path: "missing.txt", find: "x", replace: "y" }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("workspace path escape is blocked", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-escape-"));
    const result = runReadTool({
      path: "../outside.txt",
    }, {
      workspaceRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("escapes workspace root");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("workspace symlink pointing outside is rejected for read/write/edit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-link-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "top-secret\n", "utf8");
    fs.symlinkSync(outside, path.join(root, "link"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "direct-link.txt"));
    try {
      const read = runReadTool({ path: "link/secret.txt" }, { workspaceRoot: root });
      expect(read.ok).toBe(false);
      expect(read.error).toContain("escapes workspace root");

      const readDirect = runReadTool({ path: "direct-link.txt" }, { workspaceRoot: root });
      expect(readDirect.ok).toBe(false);
      expect(readDirect.error).toContain("escapes workspace root");

      const write = runWriteTool({ path: "link/evil.txt", content: "pwned" }, { workspaceRoot: root });
      expect(write.ok).toBe(false);
      expect(write.error).toContain("escapes workspace root");
      expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false);

      const edit = runEditTool(
        { path: "direct-link.txt", find: "top-secret", replace: "pwned" },
        { workspaceRoot: root }
      );
      expect(edit.ok).toBe(false);
      expect(edit.error).toContain("escapes workspace root");
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("top-secret\n");

      // Control: plain in-workspace paths still work (tmpdir itself sits
      // behind a symlink on macOS, so this also guards against false positives).
      const okWrite = runWriteTool({ path: "normal/file.txt", content: "fine" }, { workspaceRoot: root });
      expect(okWrite.ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("edit tool description documents the not-found failure", () => {
    expect(getEditToolDescription()).toContain("not found");
  });

  test("bash clamps timeoutMs to the 600s maximum and keeps the 60s default", () => {
    const spawnSync = jest.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    jest.doMock("child_process", () => ({ ...jest.requireActual("child_process"), spawnSync }));
    try {
      let runBashToolIsolated;
      jest.isolateModules(() => {
        ({ runBashTool: runBashToolIsolated } = require("../../../src/code/tools/bash"));
      });
      const over = runBashToolIsolated({ command: "true", timeoutMs: 99999999 }, { workspaceRoot: "/tmp" });
      expect(over.ok).toBe(true);
      expect(spawnSync).toHaveBeenLastCalledWith("true", expect.objectContaining({ timeout: 600000 }));
      runBashToolIsolated({ command: "true" }, { workspaceRoot: "/tmp" });
      expect(spawnSync).toHaveBeenLastCalledWith("true", expect.objectContaining({ timeout: 60000 }));
    } finally {
      jest.dontMock("child_process");
    }
  });

  test("bash reports signal-killed commands as failures", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-signal-"));
    const result = runBashTool({ command: "kill -9 $$" }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.signal).toBe("SIGKILL");
    expect(result.error).toContain("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("bash enforces timeoutMs and fails timed-out commands", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-timeout-"));
    const result = runBashTool({ command: "sleep 5", timeoutMs: 200 }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.error).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("async bash terminates when its AbortSignal is cancelled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-async-cancel-"));
    const controller = new AbortController();
    const run = runBashToolAsync({
      command: "node -e \"setTimeout(() => {}, 5000)\"",
    }, {
      workspaceRoot: root,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.error).toContain("cancelled");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("read loads only a bounded prefix for files over the full-read limit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-core-bigread-"));
    const file = path.join(root, "big.txt");
    fs.writeFileSync(file, `${"x".repeat(MAX_FULL_READ_BYTES)}TAIL-MARKER`, "utf8");
    const spy = jest.spyOn(fs, "readFileSync");
    try {
      const result = runReadTool({ path: "big.txt" }, { workspaceRoot: root });
      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(result.content).not.toContain("TAIL-MARKER");
      expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(200000);
    } finally {
      spy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("read tool description matches implementation (no line numbers claimed)", () => {
    const desc = getReadToolDescription();
    expect(desc).not.toContain("returned with line numbers");
    expect(desc).toContain("totalLines");
    expect(desc).toContain("truncated");
  });

  test("bash tool description documents the timeout ceiling and background log observation", () => {
    const desc = getBashToolDescription();
    expect(desc).toContain("600 seconds");
    expect(desc).toContain("background: true");
    expect(desc).toContain('action: "logs"');
    expect(desc).toContain("nextOffset");
  });

  test("bash background=true starts a service, observes incremental and tail logs, lists, and stops", async () => {
    const { countRunningBackgroundProcesses } = require("../../../src/code/tools/bash");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-bg-bash-"));
    const scriptPath = path.join(root, "server.js");
    fs.writeFileSync(
      scriptPath,
      [
        "setTimeout(() => {",
        'console.log("READY http://127.0.0.1:5173");',
        "let tick = 0;",
        "setInterval(() => {",
        "  tick += 1;",
        '  console.log("TICK " + tick);',
        "}, 50);",
        "}, 300);",
      ].join("\n"),
      "utf8",
    );

    let backgroundId = "";
    try {
      const started = await runBashToolAsync({
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
        background: true,
        startupWaitMs: 0,
      }, {
        workspaceRoot: root,
        sessionId: "sess-bg-1",
      });
      backgroundId = started.backgroundId;

      expect(started.ok).toBe(true);
      expect(started.kind).toBe("background_bash");
      expect(started.action).toBe("run");
      expect(started.running).toBe(true);
      expect(started.status).toBe("running");
      expect(started.backgroundId).toMatch(/^bg_/);
      // Starting a process does not guarantee Node has emitted output yet on a busy host.
      const ready = await waitForBackgroundLog(
        (args) => runBashToolAsync(args, { workspaceRoot: root }),
        started,
        "READY http://127.0.0.1:5173",
      );
      expect(ready.nextOffset).toBeGreaterThan(0);
      expect(countRunningBackgroundProcesses({ workspaceRoot: root })).toBe(1);

      const incremental = await runBashToolAsync({
        action: "logs",
        backgroundId,
        offset: ready.nextOffset,
        waitMs: 500,
      }, {
        workspaceRoot: root,
      });
      expect(incremental.ok).toBe(true);
      expect(incremental.running).toBe(true);
      expect(incremental.offset).toBe(ready.nextOffset);
      expect(incremental.nextOffset).toBeGreaterThan(ready.nextOffset);
      expect(incremental.logOutput).toContain("TICK ");
      expect(incremental.logOutput).not.toContain("READY http://127.0.0.1:5173");

      const tailed = await runBashToolAsync({
        action: "logs",
        backgroundId,
        tailLines: 2,
      }, {
        workspaceRoot: root,
      });
      expect(tailed.ok).toBe(true);
      const nonEmptyLines = tailed.logOutput.trim().split("\n").filter(Boolean);
      expect(nonEmptyLines.length).toBeLessThanOrEqual(2);

      const listed = await runBashToolAsync({
        action: "list",
      }, {
        workspaceRoot: root,
      });
      expect(listed.ok).toBe(true);
      expect(listed.count).toBe(1);
      expect(listed.runningCount).toBe(1);
      expect(listed.processes[0].backgroundId).toBe(backgroundId);

      const stopped = await runBashToolAsync({
        action: "stop",
        backgroundId,
      }, {
        workspaceRoot: root,
      });
      expect(stopped.ok).toBe(true);
      expect(stopped.running).toBe(false);
      expect(stopped.status).toBe("stopped");
      expect(countRunningBackgroundProcesses({ workspaceRoot: root })).toBe(0);
    } finally {
      if (backgroundId) {
        await runBashToolAsync({ action: "stop", backgroundId }, { workspaceRoot: root }).catch(() => {});
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

  test("bash background=true reports immediate startup failure with captured stderr", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-bg-crash-"));
    try {
      const crashed = await runBashToolAsync({
        command: `${JSON.stringify(process.execPath)} -e "console.error('EADDRINUSE: port 5173 already in use'); process.exit(2)"`,
        background: true,
        startupWaitMs: 800,
      }, {
        workspaceRoot: root,
      });
      expect(crashed.ok).toBe(false);
      expect(crashed.kind).toBe("background_bash");
      expect(crashed.running).toBe(false);
      expect(crashed.status).toBe("exited");
      expect(crashed.exitCode).toBe(2);
      expect(crashed.logOutput).toContain("EADDRINUSE: port 5173 already in use");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("CodingCapability schema + context reducer preserve background logs and allow read-only log checks under writer lease", async () => {
    const { createCodingCapability } = require("../../../src/agents/capabilities/coding");
    const { createToolRegistry } = require("../../../src/agents/runtime/tools/registry");
    const { createResourceLease } = require("../../../src/agents/runtime/tasks/resourceLease");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-bg-e2e-"));
    const realRoot = fs.realpathSync(root);
    const scriptPath = path.join(realRoot, "watch.js");
    fs.writeFileSync(
      scriptPath,
      [
        'console.log("VITE v5.0 ready in 120 ms -> http://localhost:5173/");',
        "let step = 0;",
        "setInterval(() => { step += 1; console.log('HMR update ' + step); }, 50);",
      ].join("\n"),
      "utf8",
    );

    const registry = createToolRegistry({
      tools: createCodingCapability().tools,
      grantedPermissions: ["workspace.read", "workspace.write", "workspace.execute"],
    });

    let backgroundId = "";
    try {
      const startRes = await registry.execute("bash", {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
        background: true,
        startupWaitMs: 250,
      }, {
        workspaceRoot: realRoot,
        sessionId: "sess-e2e",
      });
      backgroundId = startRes.backgroundId;

      expect(startRes.ok).toBe(true);
      expect(startRes.kind).toBe("background_bash");
      expect(startRes.artifactId).toBeTruthy();
      expect(startRes.backgroundId).toMatch(/^bg_/);
      const ready = await waitForBackgroundLog(
        (args) => registry.execute("bash", args, { workspaceRoot: realRoot, sessionId: "sess-e2e" }),
        startRes,
        "http://localhost:5173/",
      );

      // Acquire workspace writer lease as a different owner; read-only action="logs" must still succeed without command.
      const lease = createResourceLease({
        file: path.join(realRoot, ".ufoo", "agent", "runtime", "workspace-leases.json"),
      });
      const held = lease.acquire({ key: realRoot, ownerId: "other-writer" });
      expect(held.ok).toBe(true);
      try {
        const logRes = await registry.execute("bash", {
          action: "logs",
          backgroundId,
          offset: ready.nextOffset,
          waitMs: 400,
        }, {
          workspaceRoot: realRoot,
          sessionId: "sess-e2e",
        });
        expect(logRes.ok).toBe(true);
        expect(logRes.kind).toBe("background_bash");
        expect(logRes.logOutput).toContain("HMR update");
      } finally {
        lease.release({ key: realRoot, token: held.token });
      }

      const stopRes = await registry.execute("bash", {
        action: "stop",
        backgroundId,
      }, {
        workspaceRoot: realRoot,
        sessionId: "sess-e2e",
      });
      expect(stopRes.ok).toBe(true);
      expect(stopRes.status).toBe("stopped");
    } finally {
      if (backgroundId) {
        await runBashToolAsync({ action: "stop", backgroundId }, { workspaceRoot: realRoot }).catch(() => {});
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});
