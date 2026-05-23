const {
  appendStartupBootstrapArg,
  buildPtyInputFromEvent,
  parseInputMessage,
  resolvePtyBootstrapArgs,
  resolveCommand,
} = require("../../../src/agent/ptyRunner");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("agent ptyRunner input parsing", () => {
  test("drops stream envelopes instead of injecting them as prompts", () => {
    expect(parseInputMessage(JSON.stringify({ stream: true, delta: "Working" }))).toBeNull();
    expect(parseInputMessage(JSON.stringify({ stream: true, done: true, reason: "idle" }))).toBeNull();
  });

  test("keeps raw, text, and plain messages consumable", () => {
    expect(parseInputMessage(JSON.stringify({ raw: true, data: "\u001b[A" }))).toEqual({
      raw: true,
      text: "\u001b[A",
    });
    expect(parseInputMessage(JSON.stringify({ text: "do work" }))).toEqual({
      raw: false,
      text: "do work",
    });
    expect(parseInputMessage("plain task")).toEqual({
      raw: false,
      text: "plain task",
    });
  });

  test("builds manual prompt envelope for chat-direct events", () => {
    const input = buildPtyInputFromEvent(
      {
        event: "message",
        publisher: "ufoo-agent",
        target: "codex:abc",
        data: { message: "do work", source: "chat-direct" },
      },
      "codex:abc",
      {
        "codex:abc": {
          nickname: "worker",
        },
      }
    );

    expect(input).toEqual({
      raw: false,
      text: "[manual]<to:codex:abc(worker)>\ndo work",
    });
  });

  test("builds bus prompt envelope for pty events with tags", () => {
    const input = buildPtyInputFromEvent(
      {
        event: "message",
        publisher: "codex:sender",
        target: "codex:abc",
        data: { message: "report body", tags: ["report"], task_id: "T-9" },
      },
      "codex:abc",
      {
        "codex:sender": {
          nickname: "planner",
        },
      }
    );

    expect(input).toEqual({
      raw: false,
      text: "[ufoo]<from:codex:sender(planner)> [report] [task:T-9]\nreport body",
    });
  });

  test("pty raw and stream events bypass prompt envelope", () => {
    expect(buildPtyInputFromEvent(
      {
        event: "message",
        publisher: "ufoo-agent",
        data: { message: JSON.stringify({ stream: true, delta: "Working" }) },
      },
      "codex:abc",
      {}
    )).toBeNull();

    expect(buildPtyInputFromEvent(
      {
        event: "message",
        publisher: "ufoo-agent",
        data: { message: JSON.stringify({ raw: true, data: "\u001b[A" }) },
      },
      "codex:abc",
      {}
    )).toEqual({
      raw: true,
      text: "\u001b[A",
    });
  });

  test("appends codex startup bootstrap as initial prompt when no prompt arg exists", () => {
    const args = appendStartupBootstrapArg("codex", ["--json"], {
      UFOO_STARTUP_BOOTSTRAP_TEXT: "ufoo protocol bootstrap",
    });
    expect(args).toEqual(["--json", "ufoo protocol bootstrap"]);
  });

  test("does not treat option values as existing codex prompts", () => {
    const args = appendStartupBootstrapArg("codex", ["--model", "gpt-5"], {
      UFOO_STARTUP_BOOTSTRAP_TEXT: "ufoo protocol bootstrap",
    });
    expect(args).toEqual(["--model", "gpt-5", "ufoo protocol bootstrap"]);
  });

  test("does not treat common codex config option values as prompts", () => {
    const env = { UFOO_STARTUP_BOOTSTRAP_TEXT: "ufoo protocol bootstrap" };

    expect(appendStartupBootstrapArg("codex", ["-c", "key=value"], env))
      .toEqual(["-c", "key=value", "ufoo protocol bootstrap"]);
    expect(appendStartupBootstrapArg("codex", ["--cwd", "/tmp"], env))
      .toEqual(["--cwd", "/tmp", "ufoo protocol bootstrap"]);
    expect(appendStartupBootstrapArg("codex", ["--ask-for-approval", "on-request"], env))
      .toEqual(["--ask-for-approval", "on-request", "ufoo protocol bootstrap"]);
  });

  test("does not append codex startup bootstrap over an existing prompt arg", () => {
    const args = appendStartupBootstrapArg("codex", ["do the task"], {
      UFOO_STARTUP_BOOTSTRAP_TEXT: "ufoo protocol bootstrap",
    });
    expect(args).toEqual(["do the task"]);
  });

  test("resolveCommand forwards startup bootstrap to codex command args", () => {
    const original = process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;
    process.env.UFOO_STARTUP_BOOTSTRAP_TEXT = "ufoo ctx decisions -l";
    try {
      const resolved = resolveCommand("codex", []);
      expect(resolved.command).toBe("codex");
      expect(resolved.args).toContain("ufoo ctx decisions -l");
    } finally {
      if (original === undefined) {
        delete process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;
      } else {
        process.env.UFOO_STARTUP_BOOTSTRAP_TEXT = original;
      }
    }
  });

  test("resolveCommand creates default codex bootstrap when env is absent", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-pty-bootstrap-"));
    try {
      const resolved = resolveCommand("codex", [], { projectRoot, env: {} });
      expect(resolved.args).toContainEqual(expect.stringContaining("ufoo ctx decisions -l"));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resolvePtyBootstrapArgs prepares claude append-system-prompt bootstrap", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-pty-claude-bootstrap-"));
    try {
      const resolved = resolvePtyBootstrapArgs("claude-code", [], { projectRoot, env: {} });
      expect(resolved.args).toEqual([
        "--append-system-prompt",
        expect.stringContaining(path.join("claude-code", "default-bootstrap.md")),
      ]);
      expect(fs.readFileSync(resolved.args[1], "utf8")).toContain("ufoo ctx decisions -l");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
