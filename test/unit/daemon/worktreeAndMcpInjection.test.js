"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  resolveWorkerWorktreePlan,
  slugifyBranchSegment,
} = require("../../../src/runtime/worktree/worktreeManager");
const {
  resolveWorkspacePath,
  clearWorktreePathCache,
} = require("../../../src/code/tools/common");
const { runReadTool } = require("../../../src/code/tools/read");
const { runWriteTool } = require("../../../src/code/tools/write");
const {
  MANAGED_WORKER_HIDDEN_MCP_TOOLS,
  buildManagedMcpHeaders,
  buildCodexMcpConfig,
} = require("../../../src/runtime/daemon/workerMcpInjection");
const { buildCodexOptions } = require("../../../src/agents/providers/codexThreadProvider");

describe("Shared Workspace & Cross-Worktree Access", () => {
  const projectRoot = "/tmp/demo-repo";

  test("defaults to shared workspace without forcing worktree isolation even with concurrent workers", () => {
    const first = resolveWorkerWorktreePlan({
      projectRoot,
      activeWritableCount: 0,
    });
    expect(first.useWorktree).toBe(false);
    expect(first.cwd).toBe(projectRoot);
    expect(first.mode).toBe("shared_workspace");

    const second = resolveWorkerWorktreePlan({
      projectRoot,
      activeWritableCount: 3,
    });
    expect(second.useWorktree).toBe(false);
    expect(second.cwd).toBe(projectRoot);
    expect(second.mode).toBe("shared_workspace");

    const explicit = resolveWorkerWorktreePlan({
      projectRoot,
      explicitMode: "isolated",
    });
    expect(explicit.useWorktree).toBe(true);
    expect(explicit.mode).toBe("explicit_isolated");
  });

  test("allows agents to read and write freely across linked git worktrees of the same repository while still rejecting outside paths", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cross-wt-"));
    const mainRepo = path.join(tmpBase, "repo");
    const wtA = path.join(tmpBase, "wt-a");
    const wtB = path.join(tmpBase, "wt-b");
    const outside = path.join(tmpBase, "outside");
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "do not read");

    execFileSync("git", ["init", "--quiet"], { cwd: mainRepo });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "init"], { cwd: mainRepo });
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", wtA], { cwd: mainRepo });
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", wtB], { cwd: mainRepo });
    clearWorktreePathCache();

    try {
      // Agent starting in wtA can write to wtB and read from mainRepo & wtB freely
      const writeRes = runWriteTool({ path: path.join(wtB, "shared.txt"), content: "from-wt-a" }, { workspaceRoot: wtA });
      expect(writeRes.ok).toBe(true);
      const readRes = runReadTool({ path: path.join(wtB, "shared.txt") }, { workspaceRoot: mainRepo });
      expect(readRes.ok).toBe(true);
      expect(readRes.content).toBe("from-wt-a");

      // Paths outside all registered git worktrees of this repo are still strictly rejected
      expect(() => resolveWorkspacePath(wtA, path.join(outside, "secret.txt"))).toThrow("path escapes workspace root");
    } finally {
      clearWorktreePathCache();
      try { execFileSync("git", ["worktree", "remove", "--force", wtA], { cwd: mainRepo }); } catch {}
      try { execFileSync("git", ["worktree", "remove", "--force", wtB], { cwd: mainRepo }); } catch {}
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("slugifyBranchSegment sanitizes branch names safely", () => {
    expect(slugifyBranchSegment("Feature / Auth Fix #12")).toBe("feature-auth-fix-12");
  });
});

describe("Managed Worker MCP Injection & Tool Filtering", () => {
  test("hides external polling/lifecycle tools from managed workers", () => {
    expect(MANAGED_WORKER_HIDDEN_MCP_TOOLS.has("wait_for_message")).toBe(true);
    expect(MANAGED_WORKER_HIDDEN_MCP_TOOLS.has("poll_inbox")).toBe(true);
    expect(MANAGED_WORKER_HIDDEN_MCP_TOOLS.has("register_agent")).toBe(true);
    expect(MANAGED_WORKER_HIDDEN_MCP_TOOLS.has("dispatch_message")).toBe(false);
    expect(MANAGED_WORKER_HIDDEN_MCP_TOOLS.has("read_open_decisions")).toBe(false);
  });

  test("builds authenticated internal launch headers", () => {
    const headers = buildManagedMcpHeaders({
      token: "secret-tok",
      projectRoot: "/repo",
      subscriber: "acp-gemini:1234",
    });
    expect(headers.Authorization).toBe("Bearer secret-tok");
    expect(headers["X-Ufoo-Launch-Mode"]).toBe("internal");
    expect(headers["X-Ufoo-Subscriber"]).toBe("acp-gemini:1234");
  });

  test("builds Codex SDK config.mcp_servers.ufoo injection and merges into codexOptions", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { getUfooPaths } = require("../../../src/coordination/state/paths");
    const controllerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-mcp-"));
    try {
      const paths = getUfooPaths(controllerRoot);
      fs.mkdirSync(path.dirname(paths.mcpEndpoint), { recursive: true });
      fs.writeFileSync(paths.mcpEndpoint, JSON.stringify({ endpoint: "http://127.0.0.1:47631/mcp" }), "utf8");
      fs.writeFileSync(paths.mcpToken, "tok-xyz\n", "utf8");

      const mcpConfig = buildCodexMcpConfig({
        projectRoot: "/repo",
        subscriber: "codex:abcd1234",
        controllerRoot,
      });
      expect(mcpConfig).toMatchObject({
        mcp_servers: {
          ufoo: {
            url: "http://127.0.0.1:47631/mcp",
            enabled: true,
            http_headers: {
              Authorization: "Bearer tok-xyz",
              "X-Ufoo-Launch-Mode": "internal",
              "X-Ufoo-Project-Root": "/repo",
              "X-Ufoo-Subscriber": "codex:abcd1234",
            },
          },
        },
      });
      expect(mcpConfig.mcp_servers.ufoo.disabled_tools).toContain("wait_for_message");

      const codexOpts = buildCodexOptions({ mcpConfig });
      expect(codexOpts.config.mcp_servers.ufoo.url).toBe("http://127.0.0.1:47631/mcp");
    } finally {
      fs.rmSync(controllerRoot, { recursive: true, force: true });
    }
  });
});
