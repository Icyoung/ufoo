const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  __private,
  scheduleProviderSessionProbe,
  loadProviderSessionCache,
} = require("../../../src/daemon/providerSessions");

describe("daemon providerSessions probe command", () => {
  test("uses /ufoo marker for claude-code", () => {
    expect(__private.buildProbeCommand("claude-code", "claude-1")).toBe("/ufoo claude-1");
  });

  test("uses $ufoo marker for codex", () => {
    expect(__private.buildProbeCommand("codex", "codex-1")).toBe("$ufoo codex-1");
  });

  test("recordContainsMarker recognizes /ufoo, $ufoo and legacy ufoo", () => {
    const marker = "codex-1";
    expect(__private.recordContainsMarker(null, marker, "/ufoo codex-1")).toBe(true);
    expect(__private.recordContainsMarker(null, marker, "$ufoo codex-1")).toBe(true);
    expect(__private.recordContainsMarker(null, marker, "ufoo codex-1")).toBe(true);
  });

  test("recordContainsMarker checks parsed record fields", () => {
    const marker = "codex-9";
    expect(__private.recordContainsMarker({ display: "$ufoo codex-9" }, marker, "")).toBe(true);
    expect(__private.recordContainsMarker({ text: "/ufoo codex-9" }, marker, "")).toBe(true);
    expect(__private.recordContainsMarker({ prompt: "ufoo codex-9" }, marker, "")).toBe(true);
  });

  test("recordContainsMarker does not collide similar nicknames", () => {
    const marker = "codex-1";
    expect(__private.recordContainsMarker(null, marker, "$ufoo codex-10")).toBe(false);
    expect(__private.recordContainsMarker(null, marker, "/ufoo codex-10")).toBe(false);
    expect(__private.recordContainsMarker({ display: "ufoo codex-10" }, marker, "")).toBe(false);
  });

  test("containsProbeCommand enforces token boundary", () => {
    expect(__private.containsProbeCommand("\"$ufoo codex-1\"", "codex-1")).toBe(true);
    expect(__private.containsProbeCommand("... /ufoo codex-1,", "codex-1")).toBe(true);
    expect(__private.containsProbeCommand("$ufoo codex-10", "codex-1")).toBe(false);
  });

  test("escapeRegExp handles special characters", () => {
    expect(__private.escapeRegExp("a+b*c")).toBe("a\\+b\\*c");
    expect(__private.escapeRegExp("")).toBe("");
    expect(__private.escapeRegExp(null)).toBe("");
  });

  test("containsProbeCommand returns false for empty inputs", () => {
    expect(__private.containsProbeCommand("", "marker")).toBe(false);
    expect(__private.containsProbeCommand(null, "marker")).toBe(false);
    expect(__private.containsProbeCommand("text", "")).toBe(false);
  });

  test("recordContainsMarker checks input/message/query/content fields", () => {
    const marker = "test-1";
    expect(__private.recordContainsMarker({ input: "/ufoo test-1" }, marker, "")).toBe(true);
    expect(__private.recordContainsMarker({ message: "/ufoo test-1" }, marker, "")).toBe(true);
    expect(__private.recordContainsMarker({ query: "/ufoo test-1" }, marker, "")).toBe(true);
    expect(__private.recordContainsMarker({ content: "/ufoo test-1" }, marker, "")).toBe(true);
  });

  test("recordContainsMarker returns false for empty marker", () => {
    expect(__private.recordContainsMarker({}, "", "text")).toBe(false);
  });

  test("recordContainsMarker returns false for non-object record without rawLine match", () => {
    expect(__private.recordContainsMarker("string", "marker", "no match")).toBe(false);
  });

  test("buildProbeCommand handles empty/null nickname", () => {
    expect(__private.buildProbeCommand("codex", "")).toBe("$ufoo ");
    expect(__private.buildProbeCommand("codex", null)).toBe("$ufoo ");
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

describe("scheduleProviderSessionProbe", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ps-probe-"));
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
      scheduleProviderSessionProbe({ projectRoot, subscriberId: "", agentType: "codex", nickname: "b" })
    ).toBeNull();
  });

  test("returns null when agentType is missing", () => {
    expect(
      scheduleProviderSessionProbe({ projectRoot, subscriberId: "codex:a", agentType: "", nickname: "b" })
    ).toBeNull();
  });

  test("returns null for unsupported agent type", () => {
    expect(
      scheduleProviderSessionProbe({ projectRoot, subscriberId: "x:a", agentType: "custom", nickname: "b" })
    ).toBeNull();
  });

  test("returns null when nickname is missing", () => {
    expect(
      scheduleProviderSessionProbe({ projectRoot, subscriberId: "codex:a", agentType: "codex", nickname: "" })
    ).toBeNull();
  });

  test("returns handle with triggerNow for valid args", () => {
    const result = scheduleProviderSessionProbe({
      projectRoot,
      subscriberId: "codex:abc",
      agentType: "codex",
      nickname: "builder",
      delayMs: 999999,
    });
    expect(result).not.toBeNull();
    expect(result.subscriberId).toBe("codex:abc");
    expect(result.marker).toBe("builder");
    expect(typeof result.triggerNow).toBe("function");
    // Trigger to clean up timer (inject will fail, that's OK)
    result.triggerNow().catch(() => {});
  });
});
