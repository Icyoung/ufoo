const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  runReadTool,
  runWriteTool,
  runEditTool,
  runBashTool,
  runToolCall,
} = require("../../../src/code");
const { MAX_FULL_READ_BYTES } = require("../../../src/code/tools/read");
const { getReadToolDescription } = require("../../../src/agents/prompts/native/toolDescriptions/read");
const { getEditToolDescription } = require("../../../src/agents/prompts/native/toolDescriptions/edit");
const { getBashToolDescription } = require("../../../src/agents/prompts/native/toolDescriptions/bash");

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

  test("bash tool description documents the timeout ceiling", () => {
    expect(getBashToolDescription()).toContain("600 seconds");
  });
});
