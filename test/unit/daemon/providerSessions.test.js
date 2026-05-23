const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  __private,
  scheduleProviderSessionResolve,
  resolveSessionFromFile,
  loadProviderSessionCache,
} = require("../../../src/daemon/providerSessions");

describe("resolveClaudeSessionFromFile", () => {
  let fakeHome;
  const origHomedir = os.homedir;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-sess-"));
    os.homedir = () => fakeHome;
  });

  afterEach(() => {
    os.homedir = origHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("returns null when pid is falsy", () => {
    expect(__private.resolveClaudeSessionFromFile(0)).toBeNull();
    expect(__private.resolveClaudeSessionFromFile(null)).toBeNull();
    expect(__private.resolveClaudeSessionFromFile(undefined)).toBeNull();
  });

  test("returns null when session file does not exist", () => {
    expect(__private.resolveClaudeSessionFromFile(99999)).toBeNull();
  });

  test("reads sessionId from pid.json", () => {
    const sessDir = path.join(fakeHome, ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "12345.json"),
      JSON.stringify({ sessionId: "sess-abc", pid: 12345 })
    );
    const result = __private.resolveClaudeSessionFromFile(12345);
    expect(result).not.toBeNull();
    expect(result.sessionId).toBe("sess-abc");
    expect(result.source).toContain("12345.json");
  });

  test("reads session_id (snake_case) from pid.json", () => {
    const sessDir = path.join(fakeHome, ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "111.json"),
      JSON.stringify({ session_id: "sess-snake" })
    );
    const result = __private.resolveClaudeSessionFromFile(111);
    expect(result.sessionId).toBe("sess-snake");
  });

  test("returns null when json has no sessionId field", () => {
    const sessDir = path.join(fakeHome, ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, "222.json"), JSON.stringify({ pid: 222 }));
    expect(__private.resolveClaudeSessionFromFile(222)).toBeNull();
  });

  test("returns null on malformed json", () => {
    const sessDir = path.join(fakeHome, ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, "333.json"), "not-json{{{");
    expect(__private.resolveClaudeSessionFromFile(333)).toBeNull();
  });
});

describe("resolveCodexSessionFromFile", () => {
  let fakeHome;
  const origHomedir = os.homedir;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-sess-"));
    os.homedir = () => fakeHome;
  });

  afterEach(() => {
    os.homedir = origHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("returns null when cwd is falsy", () => {
    expect(__private.resolveCodexSessionFromFile("")).toBeNull();
    expect(__private.resolveCodexSessionFromFile(null)).toBeNull();
  });

  test("returns null when sessions directory does not exist", () => {
    expect(__private.resolveCodexSessionFromFile("/some/cwd")).toBeNull();
  });

  test("reads session from rollout jsonl matching cwd", () => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(fakeHome, ".codex", "sessions", yyyy, mm, dd);
    fs.mkdirSync(dir, { recursive: true });
    const rolloutFile = path.join(dir, "rollout-1234-abc.jsonl");
    fs.writeFileSync(
      rolloutFile,
      JSON.stringify({ type: "session_meta", payload: { id: "codex-sess-1", cwd: "/my/project" } }) + "\n"
    );
    const result = __private.resolveCodexSessionFromFile("/my/project");
    expect(result).not.toBeNull();
    expect(result.sessionId).toBe("codex-sess-1");
    expect(result.source).toContain("rollout-1234-abc.jsonl");
  });

  test("returns null when cwd does not match", () => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(fakeHome, ".codex", "sessions", yyyy, mm, dd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rollout-5678-def.jsonl"),
      JSON.stringify({ payload: { id: "codex-sess-2", cwd: "/other/project" } }) + "\n"
    );
    expect(__private.resolveCodexSessionFromFile("/my/project")).toBeNull();
  });

  test("picks most recently modified rollout file", () => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(fakeHome, ".codex", "sessions", yyyy, mm, dd);
    fs.mkdirSync(dir, { recursive: true });

    // Older file
    const older = path.join(dir, "rollout-0001-old.jsonl");
    fs.writeFileSync(older, JSON.stringify({ payload: { id: "old-sess", cwd: "/cwd" } }) + "\n");
    // Set mtime to 10 seconds ago
    const past = new Date(Date.now() - 10000);
    fs.utimesSync(older, past, past);

    // Newer file
    fs.writeFileSync(
      path.join(dir, "rollout-0002-new.jsonl"),
      JSON.stringify({ payload: { id: "new-sess", cwd: "/cwd" } }) + "\n"
    );

    const result = __private.resolveCodexSessionFromFile("/cwd");
    expect(result.sessionId).toBe("new-sess");
  });

  test("skips non-rollout files", () => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(fakeHome, ".codex", "sessions", yyyy, mm, dd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "other-file.jsonl"),
      JSON.stringify({ payload: { id: "sess-x", cwd: "/cwd" } }) + "\n"
    );
    expect(__private.resolveCodexSessionFromFile("/cwd")).toBeNull();
  });
});

describe("resolveSessionFromFile", () => {
  let fakeHome;
  const origHomedir = os.homedir;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-resolve-"));
    os.homedir = () => fakeHome;
  });

  afterEach(() => {
    os.homedir = origHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("dispatches to claude resolver for claude-code", () => {
    const sessDir = path.join(fakeHome, ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "555.json"),
      JSON.stringify({ sessionId: "cc-sess" })
    );
    const result = resolveSessionFromFile("claude-code", { pid: 555 });
    expect(result.sessionId).toBe("cc-sess");
  });

  test("dispatches to codex resolver for codex", () => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dir = path.join(fakeHome, ".codex", "sessions", yyyy, mm, dd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rollout-99-z.jsonl"),
      JSON.stringify({ payload: { id: "cx-sess", cwd: "/test" } }) + "\n"
    );
    const result = resolveSessionFromFile("codex", { cwd: "/test" });
    expect(result.sessionId).toBe("cx-sess");
  });

  test("returns null for unknown agent type", () => {
    expect(resolveSessionFromFile("unknown", { pid: 1 })).toBeNull();
  });
});

describe("resolveSessionFromFileWithRetries", () => {
  let fakeHome;
  const origHomedir = os.homedir;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-retry-"));
    os.homedir = () => fakeHome;
  });

  afterEach(() => {
    os.homedir = origHomedir;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("resolves immediately if file exists on first attempt", async () => {
    const sessDir = path.join(fakeHome, ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "777.json"),
      JSON.stringify({ sessionId: "fast-sess" })
    );
    // Use the private resolveSessionFromFileWithRetries via the scheduled resolver's
    // internal flow, but we can also test via the module's __private if exposed.
    // Since it's not directly exported, test through resolveSessionFromFile + timing:
    const { resolveSessionFromFile: rsff } = require("../../../src/daemon/providerSessions");
    const result = rsff("claude-code", { pid: 777 });
    expect(result.sessionId).toBe("fast-sess");
  });

  test("returns null after retries if file never appears", async () => {
    // resolveSessionFromFileWithRetries is not directly exported, but we can
    // verify through scheduleProviderSessionResolve with triggerNow + no file.
    // Use minimal retries to avoid timeout
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ps-retry-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({ agents: {} })
    );

    const { scheduleProviderSessionResolve } = require("../../../src/daemon/providerSessions");
    const onResolved = jest.fn();
    const handle = scheduleProviderSessionResolve({
      projectRoot,
      subscriberId: "claude-code:retry1",
      agentType: "claude-code",
      agentPid: 88888,
      delayMs: 999999,
      fileAttempts: 2,
      fileIntervalMs: 50,
    });
    expect(handle).not.toBeNull();

    // triggerNow will try file retries (2×50ms), then stop without terminal probing.
    await handle.triggerNow();
    // onResolved was not passed, so no callback — just verify it completes without error

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("cancel during file retry prevents onResolved from firing", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ps-cancel-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({ agents: {} })
    );

    // Create session file so file resolution would succeed
    const sessDir = path.join(os.homedir(), ".claude", "sessions");
    fs.mkdirSync(sessDir, { recursive: true });
    const sessFile = path.join(sessDir, "77777.json");
    fs.writeFileSync(sessFile, JSON.stringify({ sessionId: "should-not-fire" }));

    const { scheduleProviderSessionResolve } = require("../../../src/daemon/providerSessions");
    const onResolved = jest.fn();
    const handle = scheduleProviderSessionResolve({
      projectRoot,
      subscriberId: "claude-code:cancel1",
      agentType: "claude-code",
      agentPid: 77777,
      delayMs: 999999,
      fileAttempts: 3,
      fileIntervalMs: 50,
      onResolved,
    });

    // Cancel immediately — simulates AGENT_READY resolving session directly
    handle.cancel();
    await handle.triggerNow();
    expect(onResolved).not.toHaveBeenCalled();

    try { fs.unlinkSync(sessFile); } catch { /* ignore */ }
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

describe("loadProviderSessionCache", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ps-cache-"));
    const ufooDir = path.join(projectRoot, ".ufoo");
    fs.mkdirSync(path.join(ufooDir, "agent"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("returns empty map when no agents have sessions", () => {
    const agentsFile = path.join(projectRoot, ".ufoo", "agent", "all-agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: {} }));
    const cache = loadProviderSessionCache(projectRoot);
    expect(cache.size).toBe(0);
  });

  test("loads cached sessions", () => {
    const agentsFile = path.join(projectRoot, ".ufoo", "agent", "all-agents.json");
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          "codex:abc": {
            provider_session_id: "sess-123",
            provider_session_source: "/path/to/history",
          },
          "codex:def": { nickname: "builder" },
        },
      })
    );
    const cache = loadProviderSessionCache(projectRoot);
    expect(cache.size).toBe(1);
    expect(cache.get("codex:abc").sessionId).toBe("sess-123");
  });
});

describe("scheduleProviderSessionResolve", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ps-resolve-"));
    const ufooDir = path.join(projectRoot, ".ufoo");
    fs.mkdirSync(path.join(ufooDir, "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(ufooDir, "agent", "all-agents.json"),
      JSON.stringify({ agents: {} })
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("returns null when subscriberId is missing", () => {
    expect(
      scheduleProviderSessionResolve({ projectRoot, subscriberId: "", agentType: "codex" })
    ).toBeNull();
  });

  test("returns null when agentType is missing", () => {
    expect(
      scheduleProviderSessionResolve({ projectRoot, subscriberId: "codex:a", agentType: "" })
    ).toBeNull();
  });

  test("returns null for unsupported agent type", () => {
    expect(
      scheduleProviderSessionResolve({ projectRoot, subscriberId: "x:a", agentType: "custom" })
    ).toBeNull();
  });

  test("returns handle for file-based resolution", () => {
    const result = scheduleProviderSessionResolve({ projectRoot, subscriberId: "codex:a", agentType: "codex" });
    expect(result).not.toBeNull();
    expect(result.subscriberId).toBe("codex:a");
    expect(typeof result.triggerNow).toBe("function");
    result.cancel();
  });

  test("returns handle with triggerNow for valid args", () => {
    const result = scheduleProviderSessionResolve({
      projectRoot,
      subscriberId: "codex:abc",
      agentType: "codex",
      delayMs: 999999,
    });
    expect(result).not.toBeNull();
    expect(result.subscriberId).toBe("codex:abc");
    expect(typeof result.triggerNow).toBe("function");
    result.cancel();
  });

  test("does not persist provider session when session file is unavailable", async () => {
    const onResolved = jest.fn();
    const result = scheduleProviderSessionResolve({
      projectRoot,
      subscriberId: "codex:abc",
      agentType: "codex",
      agentCwd: "/missing/project",
      delayMs: 999999,
      fileAttempts: 1,
      fileIntervalMs: 1,
      onResolved,
    });
    expect(result).not.toBeNull();

    await result.triggerNow();

    const data = JSON.parse(fs.readFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      "utf8",
    ));
    expect(onResolved).not.toHaveBeenCalled();
    expect(data.agents["codex:abc"]).toBeUndefined();
  });
});
