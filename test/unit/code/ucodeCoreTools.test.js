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

  test("edit returns ok=true changed=false when find not found", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-edit-nochange-"));
    runWriteTool({ path: "test.txt", content: "hello" }, { workspaceRoot: root });
    const result = runEditTool({ path: "test.txt", find: "xyz", replace: "abc" }, { workspaceRoot: root });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.replacements).toBe(0);
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
});
