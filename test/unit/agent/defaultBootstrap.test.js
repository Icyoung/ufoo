"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  hasMetaCommandArgs,
  buildDefaultStartupBootstrapPrompt,
  prepareDefaultBootstrapFile,
  resolveDefaultManualBootstrap,
} = require("../../../src/agent/defaultBootstrap");

describe("default bootstrap", () => {
  test("detects help and version meta args", () => {
    expect(hasMetaCommandArgs(["--help"])).toBe(true);
    expect(hasMetaCommandArgs(["-v"])).toBe(true);
    expect(hasMetaCommandArgs(["--model", "gpt-5"])).toBe(false);
  });

  test("builds shared startup bootstrap prompt", () => {
    const prompt = buildDefaultStartupBootstrapPrompt({ agentType: "codex" });
    expect(prompt).toContain("Adopt the following ufoo coordination protocol silently.");
    expect(prompt).toContain("ufoo ctx decisions -l");
    expect(prompt).toContain("ufoo bus send <target-nickname>");
  });

  test("writes default bootstrap file for claude", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-default-bootstrap-"));
    try {
      const prepared = prepareDefaultBootstrapFile({
        projectRoot,
        agentType: "claude-code",
        promptText: "hello",
      });
      expect(fs.existsSync(prepared.file)).toBe(true);
      expect(fs.readFileSync(prepared.file, "utf8")).toBe("hello");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resolves claude bootstrap as append-system-prompt file", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-default-bootstrap-"));
    try {
      const resolved = resolveDefaultManualBootstrap({
        projectRoot,
        agentType: "claude-code",
        args: [],
        env: {},
      });
      expect(resolved.mode).toBe("system-prompt-file");
      expect(resolved.args).toEqual([
        "--append-system-prompt",
        expect.stringContaining(path.join("claude-code", "default-bootstrap.md")),
      ]);
      expect(fs.existsSync(resolved.file)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("skips claude bootstrap when caller already provides system prompt", () => {
    const resolved = resolveDefaultManualBootstrap({
      projectRoot: "/tmp/ufoo",
      agentType: "claude-code",
      args: ["--append-system-prompt", "/tmp/custom.md"],
      env: {},
    });
    expect(resolved.mode).toBe("skip");
    expect(resolved.args).toEqual(["--append-system-prompt", "/tmp/custom.md"]);
  });

  test("resolves codex bootstrap as post-launch inject for blank launch", () => {
    const resolved = resolveDefaultManualBootstrap({
      projectRoot: "/tmp/ufoo",
      agentType: "codex",
      args: [],
      env: {},
    });
    expect(resolved.mode).toBe("post-launch-inject");
    expect(resolved.env.UFOO_STARTUP_BOOTSTRAP_TEXT).toContain("ufoo ctx decisions -l");
  });

  test("skips codex bootstrap when args are already present", () => {
    const resolved = resolveDefaultManualBootstrap({
      projectRoot: "/tmp/ufoo",
      agentType: "codex",
      args: ["fix the flaky test"],
      env: {},
    });
    expect(resolved.mode).toBe("skip");
    expect(resolved.env).toEqual({});
  });
});
