const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  normalizeSessionId,
  resolveSessionId,
  saveSessionSnapshot,
  loadSessionSnapshot,
  getSessionFilePath,
} = require("../../../src/code/sessionStore");

describe("ucode session store", () => {
  let workspaceRoot = "";
  const originalV2 = process.env.UFOO_UCODE_CONTEXT_V2;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-session-"));
    // Keep legacy v1 assertions unless a test enables v2 explicitly.
    process.env.UFOO_UCODE_CONTEXT_V2 = "0";
  });

  afterEach(() => {
    if (originalV2 === undefined) delete process.env.UFOO_UCODE_CONTEXT_V2;
    else process.env.UFOO_UCODE_CONTEXT_V2 = originalV2;
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("normalize/resolve session id keeps valid id and regenerates invalid", () => {
    expect(normalizeSessionId("sess-1")).toBe("sess-1");
    expect(normalizeSessionId("../bad")).toBe("");

    expect(resolveSessionId("sess-2")).toBe("sess-2");
    expect(resolveSessionId("../bad")).toMatch(/^ucode-/);
  });

  test("save and load snapshot roundtrip", () => {
    const saved = saveSessionSnapshot(workspaceRoot, {
      sessionId: "sess-roundtrip",
      workspaceRoot,
      provider: "openai",
      model: "gpt-5",
      context: "rules",
      nlMessages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });

    expect(saved.ok).toBe(true);
    expect(saved.sessionId).toBe("sess-roundtrip");
    expect(fs.existsSync(getSessionFilePath(workspaceRoot, "sess-roundtrip"))).toBe(true);

    const loaded = loadSessionSnapshot(workspaceRoot, "sess-roundtrip");
    expect(loaded.ok).toBe(true);
    expect(loaded.snapshot).toEqual(expect.objectContaining({
      sessionId: "sess-roundtrip",
      provider: "openai",
      model: "gpt-5",
      context: "rules",
      nlMessages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    }));
  });

  test("v2 snapshot externalizes transcript when context v2 enabled", () => {
    const prev = process.env.UFOO_UCODE_CONTEXT_V2;
    process.env.UFOO_UCODE_CONTEXT_V2 = "1";
    try {
      const saved = saveSessionSnapshot(workspaceRoot, {
        sessionId: "sess-v2-local",
        workspaceRoot,
        nlMessages: [{ role: "user", content: "hello" }],
      });
      expect(saved.ok).toBe(true);
      const raw = JSON.parse(fs.readFileSync(saved.filePath, "utf8"));
      expect(raw.version).toBe(2);
      expect(raw.transcript.path).toContain("sess-v2-local.jsonl");
    } finally {
      if (prev === undefined) delete process.env.UFOO_UCODE_CONTEXT_V2;
      else process.env.UFOO_UCODE_CONTEXT_V2 = prev;
    }
  });

  test("load returns not found for unknown session", () => {
    const loaded = loadSessionSnapshot(workspaceRoot, "sess-missing");
    expect(loaded.ok).toBe(false);
    expect(loaded.error).toContain("session not found");
  });

  test("save writes atomically without leaving temp files behind", () => {
    const saved = saveSessionSnapshot(workspaceRoot, {
      sessionId: "sess-atomic",
      workspaceRoot,
      nlMessages: [{ role: "user", content: "hello" }],
    });
    expect(saved.ok).toBe(true);

    const sessionsDir = path.join(workspaceRoot, ".ufoo", "agent", "ucode", "sessions");
    const entries = fs.readdirSync(sessionsDir);
    expect(entries).toEqual(["sess-atomic.json"]);

    const loaded = loadSessionSnapshot(workspaceRoot, "sess-atomic");
    expect(loaded.ok).toBe(true);
    expect(loaded.snapshot.nlMessages).toEqual([{ role: "user", content: "hello" }]);
  });
});
