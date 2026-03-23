const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCtxCommand, createUnknownCtxError } = require("../../../src/cli/ctxCoreCommands");

describe("ctxCoreCommands", () => {
  let cwd;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ctxcli-"));
    // Create .ufoo context structure
    const ctxDir = path.join(cwd, ".ufoo", "context", "decisions");
    fs.mkdirSync(ctxDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".ufoo", "context", "decisions.jsonl"),
      ""
    );
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe("createUnknownCtxError", () => {
    test("creates error with code", () => {
      const err = createUnknownCtxError("foo");
      expect(err.message).toContain("Unknown ctx subcommand: foo");
      expect(err.code).toBe("UFOO_CTX_UNKNOWN");
    });
  });

  describe("doctor subcommand", () => {
    test("runs in protocol mode by default", async () => {
      await runCtxCommand("doctor", [], { cwd });
    });

    test("runs in project mode with --project", async () => {
      const ctxPath = path.join(cwd, ".ufoo", "context");
      await runCtxCommand("doctor", ["--project", ctxPath], { cwd });
    });
  });

  describe("lint subcommand", () => {
    test("runs protocol lint", async () => {
      await runCtxCommand("lint", [], { cwd });
    });

    test("runs project lint with --project", async () => {
      const ctxPath = path.join(cwd, ".ufoo", "context");
      await runCtxCommand("lint", ["--project", ctxPath], { cwd });
    });
  });

  describe("decisions subcommand", () => {
    test("lists decisions with -l flag", async () => {
      // Create a decision
      fs.writeFileSync(
        path.join(cwd, ".ufoo", "context", "decisions", "0001-test.md"),
        "---\nstatus: open\n---\n# Test Decision"
      );

      await runCtxCommand("decisions", ["-l"], { cwd });
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    test("shows decisions with -n flag", async () => {
      fs.writeFileSync(
        path.join(cwd, ".ufoo", "context", "decisions", "0001-test.md"),
        "---\nstatus: open\n---\n# Test"
      );

      await runCtxCommand("decisions", ["-n", "1"], { cwd });
    });

    test("shows decisions with -s filter", async () => {
      await runCtxCommand("decisions", ["-s", "resolved"], { cwd });
    });

    test("shows all decisions with -a flag", async () => {
      await runCtxCommand("decisions", ["-a"], { cwd });
    });

    test("creates new decision", async () => {
      await runCtxCommand("decisions", ["new", "My New Decision"], { cwd });
      const files = fs.readdirSync(
        path.join(cwd, ".ufoo", "context", "decisions")
      );
      expect(files.some((f) => f.includes("my-new-decision"))).toBe(true);
    });

    test("creates decision with --author and --nickname", async () => {
      await runCtxCommand(
        "decisions",
        ["new", "Test", "--author", "bot", "--nickname", "builder"],
        { cwd }
      );
      const files = fs.readdirSync(
        path.join(cwd, ".ufoo", "context", "decisions")
      );
      const file = files.find((f) => f.includes("builder"));
      expect(file).toBeTruthy();
    });

    test("creates decision with --status", async () => {
      await runCtxCommand(
        "decisions",
        ["new", "Resolved One", "--status", "resolved"],
        { cwd }
      );
    });

    test("writes index", async () => {
      await runCtxCommand("decisions", ["index"], { cwd });
    });

    test("writes index with --index flag", async () => {
      await runCtxCommand("decisions", ["--index"], { cwd });
    });

    test("does not allow new/index when allowIndexNew is false", async () => {
      // When allowIndexNew=false, "new" is not handled and falls through to show
      await runCtxCommand("decisions", ["new", "test"], {
        cwd,
        allowIndexNew: false,
      });
    });

    test("supports -d flag to set decisions dir", async () => {
      const customDir = path.join(cwd, "custom-decisions");
      fs.mkdirSync(customDir, { recursive: true });
      await runCtxCommand("decisions", ["-d", customDir], { cwd });
    });
  });

  describe("sync subcommand", () => {
    test("lists syncs by default", async () => {
      await runCtxCommand("sync", [], { cwd });
    });

    test("lists syncs with explicit list action", async () => {
      await runCtxCommand("sync", ["list"], { cwd });
    });

    test("lists syncs with show action", async () => {
      await runCtxCommand("sync", ["show"], { cwd });
    });

    test("writes a sync entry", async () => {
      await runCtxCommand(
        "sync",
        [
          "write",
          "Test sync message",
          "--from", "agent-a",
          "--for", "agent-b",
          "--decision", "0001",
          "--file", "src/test.js",
          "--tests", "test/test.js",
          "--verification", "manual",
          "--risk", "low",
          "--next", "review",
        ],
        { cwd }
      );
    });

    test("writes with add action", async () => {
      await runCtxCommand("sync", ["add", "Another sync"], { cwd });
    });

    test("throws on unknown sync action", async () => {
      await expect(
        runCtxCommand("sync", ["unknown-action"], { cwd })
      ).rejects.toThrow("Unknown ctx sync action");
    });

    test("list with --num and --for and --from", async () => {
      await runCtxCommand(
        "sync",
        ["list", "-n", "5", "--for", "agent-b", "--from", "agent-a"],
        { cwd }
      );
    });
  });

  describe("unknown subcommand", () => {
    test("throws with UFOO_CTX_UNKNOWN code", async () => {
      await expect(runCtxCommand("nonexistent", [], { cwd })).rejects.toThrow(
        "Unknown ctx subcommand"
      );
    });
  });
});
