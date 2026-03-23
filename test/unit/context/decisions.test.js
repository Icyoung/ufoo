const fs = require("fs");
const os = require("os");
const path = require("path");

const DecisionsManager = require("../../../src/context/decisions");

describe("DecisionsManager", () => {
  let projectRoot;
  let consoleLogSpy;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ufoo-decisions-test-")
    );
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("resolveDecisionsDir", () => {
    test("uses AI_CONTEXT_DECISIONS_DIR env if set", () => {
      const orig = process.env.AI_CONTEXT_DECISIONS_DIR;
      process.env.AI_CONTEXT_DECISIONS_DIR = "/custom/dir";
      try {
        expect(DecisionsManager.resolveDecisionsDir(projectRoot)).toBe(
          "/custom/dir"
        );
      } finally {
        if (orig === undefined) delete process.env.AI_CONTEXT_DECISIONS_DIR;
        else process.env.AI_CONTEXT_DECISIONS_DIR = orig;
      }
    });

    test("prefers lowercase decisions directory", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const lower = path.join(ctxDir, "decisions");
      fs.mkdirSync(lower, { recursive: true });
      expect(DecisionsManager.resolveDecisionsDir(projectRoot, ctxDir)).toBe(
        lower
      );
    });

    test("falls back to lowercase default when neither exists", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      fs.mkdirSync(ctxDir, { recursive: true });
      // Neither decisions nor DECISIONS exist — should return lowercase
      const result = DecisionsManager.resolveDecisionsDir(projectRoot, ctxDir);
      expect(result).toBe(path.join(ctxDir, "decisions"));
    });

    test("uses contextDir from projectRoot when not provided", () => {
      const result = DecisionsManager.resolveDecisionsDir(projectRoot);
      const expected = path.join(projectRoot, ".ufoo", "context", "decisions");
      expect(result).toBe(expected);
    });
  });

  describe("readDecisions", () => {
    test("returns empty array when decisions dir does not exist", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.readDecisions()).toEqual([]);
    });

    test("reads and parses decision files with frontmatter", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-test-decision.md"),
        "---\nstatus: open\n---\n# DECISION 0001: Test Decision\n\nSome content"
      );

      const mgr = new DecisionsManager(projectRoot);
      const decisions = mgr.readDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].status).toBe("open");
      expect(decisions[0].title).toBe("DECISION 0001: Test Decision");
      expect(decisions[0].file).toBe("0001-test-decision.md");
    });

    test("handles files without frontmatter", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-no-fm.md"),
        "# My Decision\n\nJust plain markdown"
      );

      const mgr = new DecisionsManager(projectRoot);
      const decisions = mgr.readDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].status).toBe("open"); // default
      expect(decisions[0].title).toBe("My Decision");
    });

    test("handles files without title", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-no-title.md"),
        "---\nstatus: resolved\n---\nNo heading here"
      );

      const mgr = new DecisionsManager(projectRoot);
      const decisions = mgr.readDecisions();
      expect(decisions[0].title).toBe("(no title)");
      expect(decisions[0].status).toBe("resolved");
    });

    test("returns newest first", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-first.md"),
        "# First"
      );
      fs.writeFileSync(
        path.join(decisionsDir, "0002-second.md"),
        "# Second"
      );

      const mgr = new DecisionsManager(projectRoot);
      const decisions = mgr.readDecisions();
      expect(decisions[0].file).toBe("0002-second.md");
      expect(decisions[1].file).toBe("0001-first.md");
    });

    test("ignores non-md files", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(path.join(decisionsDir, "notes.txt"), "not a decision");
      fs.writeFileSync(path.join(decisionsDir, "0001-real.md"), "# Real");

      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.readDecisions()).toHaveLength(1);
    });
  });

  describe("nextNumber", () => {
    test("returns 0001 when no decisions exist", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.nextNumber()).toBe("0001");
    });

    test("increments from highest existing number", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(path.join(decisionsDir, "0005-something.md"), "# 5");
      fs.writeFileSync(path.join(decisionsDir, "0003-other.md"), "# 3");

      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.nextNumber()).toBe("0006");
    });
  });

  describe("slugify", () => {
    test("converts title to slug", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.slugify("Hello World!")).toBe("hello-world");
    });

    test("handles empty/special-only string", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.slugify("!!!")).toBe("decision");
    });

    test("collapses multiple dashes", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.slugify("a   b   c")).toBe("a-b-c");
    });
  });

  describe("createDecision", () => {
    test("creates decision file with frontmatter", () => {
      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.createDecision({
        title: "Test Decision",
        author: "test-agent",
        nickname: "builder",
      });
      expect(result.file).toMatch(/^0001-builder-test-decision\.md$/);
      expect(fs.existsSync(result.filePath)).toBe(true);

      const content = fs.readFileSync(result.filePath, "utf8");
      expect(content).toContain("status: open");
      expect(content).toContain("# DECISION 0001: Test Decision");
      expect(content).toContain("Author: test-agent");
    });

    test("throws when title is missing", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(() => mgr.createDecision()).toThrow("Missing title");
    });

    test("throws when title is empty", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(() => mgr.createDecision({ title: "   " })).toThrow(
        "Missing title"
      );
    });

    test("uses env vars as fallback for author/nickname", () => {
      const origNick = process.env.UFOO_NICKNAME;
      process.env.UFOO_NICKNAME = "env-nick";
      try {
        const mgr = new DecisionsManager(projectRoot);
        const result = mgr.createDecision({ title: "Env Test" });
        const content = fs.readFileSync(result.filePath, "utf8");
        expect(content).toContain("Author: env-nick");
        expect(content).toContain("nickname: env-nick");
      } finally {
        if (origNick === undefined) delete process.env.UFOO_NICKNAME;
        else process.env.UFOO_NICKNAME = origNick;
      }
    });

    test("writes index after creating decision", () => {
      const mgr = new DecisionsManager(projectRoot);
      mgr.createDecision({ title: "Index Test", author: "bot" });
      expect(fs.existsSync(mgr.indexFile)).toBe(true);
      const index = fs.readFileSync(mgr.indexFile, "utf8");
      expect(index).toContain("Index Test");
    });

    test("supports custom status", () => {
      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.createDecision({
        title: "Resolved",
        status: "resolved",
      });
      const content = fs.readFileSync(result.filePath, "utf8");
      expect(content).toContain("status: resolved");
    });
  });

  describe("extractField", () => {
    test("extracts field value from body text", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.extractField("Date: 2024-01-01\nAuthor: bot", "Date")).toBe(
        "2024-01-01"
      );
      expect(mgr.extractField("Date: 2024-01-01\nAuthor: bot", "Author")).toBe(
        "bot"
      );
    });

    test("returns empty string when field not found", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.extractField("no fields here", "Date")).toBe("");
    });
  });

  describe("normalizeTs", () => {
    test("parses valid date string to ISO", () => {
      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.normalizeTs("2024-01-15");
      expect(result).toContain("2024-01-15");
    });

    test("returns non-parseable value as-is", () => {
      const mgr = new DecisionsManager(projectRoot);
      expect(mgr.normalizeTs("not-a-date")).toBe("not-a-date");
    });

    test("uses file mtime as fallback", () => {
      const file = path.join(projectRoot, "test.txt");
      fs.writeFileSync(file, "hello");
      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.normalizeTs(null, file);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("returns current time when no value and no file", () => {
      const mgr = new DecisionsManager(projectRoot);
      const before = Date.now();
      const result = mgr.normalizeTs(null, "/nonexistent");
      const after = Date.now();
      const ts = new Date(result).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    test("returns current time when no value and no fallback path", () => {
      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.normalizeTs(null);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("buildIndexEntries", () => {
    test("builds entries for open decisions", () => {
      const mgr = new DecisionsManager(projectRoot);
      const entries = mgr.buildIndexEntries([
        {
          file: "0001-test.md",
          filePath: "/tmp/test.md",
          status: "open",
          title: "Test",
          data: {},
          body: "Date: 2024-01-01\nAuthor: bot",
        },
      ]);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("decision");
      expect(entries[0].title).toBe("Test");
    });

    test("adds status entry for non-open decisions", () => {
      const mgr = new DecisionsManager(projectRoot);
      const entries = mgr.buildIndexEntries([
        {
          file: "0001-test.md",
          filePath: "/tmp/test.md",
          status: "resolved",
          title: "Test",
          data: { resolved_at: "2024-02-01", resolved_by: "reviewer" },
          body: "Date: 2024-01-01\nAuthor: bot",
        },
      ]);
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe("decision");
      expect(entries[1].type).toBe("decision_status");
      expect(entries[1].author).toBe("reviewer");
    });

    test("uses data fields over body fields", () => {
      const mgr = new DecisionsManager(projectRoot);
      const entries = mgr.buildIndexEntries([
        {
          file: "0001-test.md",
          filePath: "/tmp/test.md",
          status: "open",
          title: "Test",
          data: { created_at: "2024-03-01", author: "data-author" },
          body: "Date: 2024-01-01\nAuthor: body-author",
        },
      ]);
      expect(entries[0].author).toBe("data-author");
    });
  });

  describe("filterDecisions", () => {
    test("filters by status", () => {
      const mgr = new DecisionsManager(projectRoot);
      const decisions = [
        { status: "open" },
        { status: "resolved" },
        { status: "open" },
      ];
      expect(mgr.filterDecisions(decisions, "open")).toHaveLength(2);
      expect(mgr.filterDecisions(decisions, "resolved")).toHaveLength(1);
    });

    test("returns all with status=all", () => {
      const mgr = new DecisionsManager(projectRoot);
      const decisions = [{ status: "open" }, { status: "resolved" }];
      expect(mgr.filterDecisions(decisions, "all")).toHaveLength(2);
    });
  });

  describe("list", () => {
    test("lists decisions filtered by status", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-a.md"),
        "---\nstatus: open\n---\n# Decision A"
      );
      fs.writeFileSync(
        path.join(decisionsDir, "0002-b.md"),
        "---\nstatus: resolved\n---\n# Decision B"
      );

      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.list({ status: "open" });
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Decision A");
    });
  });

  describe("show", () => {
    test("shows latest N decisions", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-a.md"),
        "---\nstatus: open\n---\n# A"
      );
      fs.writeFileSync(
        path.join(decisionsDir, "0002-b.md"),
        "---\nstatus: open\n---\n# B"
      );

      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.show({ num: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].file).toBe("0002-b.md");
    });

    test("shows all when all=true", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-a.md"),
        "---\nstatus: open\n---\n# A"
      );
      fs.writeFileSync(
        path.join(decisionsDir, "0002-b.md"),
        "---\nstatus: open\n---\n# B"
      );

      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.show({ all: true });
      expect(result).toHaveLength(2);
    });

    test("returns empty array when no decisions exist", () => {
      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.show();
      expect(result).toEqual([]);
    });

    test("shows message when no decisions match status filter", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-a.md"),
        "---\nstatus: resolved\n---\n# A"
      );

      const mgr = new DecisionsManager(projectRoot);
      const result = mgr.show({ status: "open" });
      expect(result).toEqual([]);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "No decisions with status 'open' found."
      );
    });
  });

  describe("writeIndex", () => {
    test("writes jsonl index file", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(decisionsDir, "0001-test.md"),
        "---\nstatus: open\n---\n# Test\n\nDate: 2024-01-01\nAuthor: bot"
      );

      const mgr = new DecisionsManager(projectRoot);
      mgr.writeIndex();

      expect(fs.existsSync(mgr.indexFile)).toBe(true);
      const content = fs.readFileSync(mgr.indexFile, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.type).toBe("decision");
      expect(entry.title).toBe("Test");
    });

    test("writes empty file when no decisions", () => {
      const mgr = new DecisionsManager(projectRoot);
      // Create context dir so writeIndex can write
      fs.mkdirSync(path.join(projectRoot, ".ufoo", "context"), {
        recursive: true,
      });
      mgr.writeIndex();
      const content = fs.readFileSync(mgr.indexFile, "utf8");
      expect(content).toBe("");
    });
  });
});
