const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  rememberHandler,
  recallHandler,
  searchMemoryHandler,
  searchHistoryHandler,
  editMemoryHandler,
  forgetMemoryHandler,
} = require("../../../src/tools/handlers/memory");

describe("memory tool handlers", () => {
  let projectRoot;
  let ctx;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-memory-tools-"));
    ctx = {
      projectRoot,
      subscriber: "codex:test",
      caller_tier: "worker",
      turn_id: "turn-1",
      tool_call_id: "call-1",
    };
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("remember writes and recall reads durable project memory", () => {
    const created = rememberHandler(ctx, {
      title: "User id invariant",
      body: "All user identifiers in this project must use UUID v7 across services.",
      tags: ["arch"],
      history_session_id: "session-1",
      history_offset: "42",
    });

    expect(created.ok).toBe(true);
    expect(created.entry).toEqual(expect.objectContaining({
      id: "mem-0001",
      source: "agent:codex:test",
    }));

    const recalled = recallHandler(ctx, { id: "mem-0001" });
    expect(recalled).toEqual(expect.objectContaining({
      ok: true,
      count: 1,
      entries: [expect.objectContaining({ title: "User id invariant" })],
    }));
    expect(fs.readFileSync(path.join(projectRoot, ".ufoo", "memory", "audit.jsonl"), "utf8")).toContain("session-1");
  });

  test("search_memory finds matching active entries", () => {
    rememberHandler(ctx, {
      title: "Stripe ownership",
      body: "Production Stripe account is owned by the founder account.",
      tags: ["billing"],
    });

    const result = searchMemoryHandler(ctx, { query: "stripe", limit: 3 });

    expect(result.count).toBe(1);
    expect(result.entries[0]).toEqual(expect.objectContaining({ id: "mem-0001" }));
  });

  test("search_history reads local provider history with redaction and from_history marker", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-memory-history-home-"));
    const claudeProjectDir = path.join(
      homeDir,
      ".claude",
      "projects",
      path.resolve(projectRoot).replace(/\//g, "-")
    );
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.writeFileSync(path.join(claudeProjectDir, "claude-session-1.jsonl"), [
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:00.000Z",
        message: {
          content: "Stripe production billing ownership evidence Bearer abc123SECRET",
        },
      }),
      "",
    ].join("\n"), "utf8");

    try {
      const result = searchHistoryHandler({
        ...ctx,
        historyHomeDir: homeDir,
      }, {
        query: "Stripe billing",
        agent: "claude",
        limit: 3,
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        from_history: true,
        count: 1,
      }));
      expect(result.snippets[0]).toEqual(expect.objectContaining({
        source: "claude-code",
        session_id: "claude-session-1",
        role: "user",
      }));
      expect(result.snippets[0].text).toContain("Bearer [REDACTED]");
      expect(fs.readFileSync(path.join(projectRoot, ".ufoo", "memory", "audit.jsonl"), "utf8")).toContain("search_history");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("remember rejects direct echo of recent search_history output", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-memory-history-home-"));
    const codexDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "20");
    const historicalText = "Production Stripe account ownership is held by the founder account and billing disputes must use that account path.";
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "rollout-2026-04-20-test.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-session-1", cwd: projectRoot } }),
      JSON.stringify({
        type: "message",
        role: "user",
        timestamp: "2026-04-20T10:00:00.000Z",
        content: historicalText,
      }),
      "",
    ].join("\n"), "utf8");

    try {
      const result = searchHistoryHandler({
        ...ctx,
        historyHomeDir: homeDir,
      }, {
        query: "Stripe ownership",
        agent: "codex",
      });
      expect(result.count).toBe(1);

      expect(() => rememberHandler(ctx, {
        title: "Stripe ownership",
        body: historicalText,
        tags: ["billing"],
      })).toThrow(expect.objectContaining({ code: "memory_history_echo" }));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("edit_memory updates arbitrary entries with conflict guard", () => {
    const created = rememberHandler(ctx, {
      title: "Vacuum window",
      body: "DBA runs vacuum every Tuesday, avoid heavy migrations in that window.",
      tags: ["ops"],
    }).entry;

    const updated = editMemoryHandler(ctx, {
      id: created.id,
      body: "DBA runs vacuum every Tuesday, avoid heavy migrations during that window.",
      expected_updated_at: created.updated_at,
    });

    expect(updated.entry.body).toContain("during that window");
    expect(() => editMemoryHandler(ctx, {
      id: created.id,
      body: "This edit should fail because the timestamp is stale.",
      expected_updated_at: created.updated_at,
    })).toThrow(expect.objectContaining({ code: "memory_conflict" }));
  });

  test("forget archives entries for all callers", () => {
    rememberHandler(ctx, {
      title: "Export rule",
      body: "Free users may export data up to three times per month.",
      tags: ["product"],
    });

    const result = forgetMemoryHandler(ctx, { id: "mem-0001" });

    expect(result.entry.status).toBe("archived");
    expect(recallHandler(ctx, { tags: ["product"] }).count).toBe(0);
    expect(recallHandler(ctx, { id: "mem-0001", include_archived: true }).count).toBe(1);
  });

  test("remember rejects low-signal or time-relative memory", () => {
    expect(() => rememberHandler(ctx, {
      title: "Current refactor",
      body: "current auth work",
    })).toThrow(expect.objectContaining({ code: "invalid_memory_body" }));

    expect(() => rememberHandler(ctx, {
      title: "Current refactor state",
      body: "The current auth refactor is being worked on by a coding agent right now.",
    })).toThrow(expect.objectContaining({ code: "memory_not_durable" }));
  });
});
