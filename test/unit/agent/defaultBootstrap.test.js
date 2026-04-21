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

  test("merges claude bootstrap when caller already provides append-system-prompt file", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-default-bootstrap-"));
    const customFile = path.join(projectRoot, "custom.md");
    fs.writeFileSync(customFile, "custom prompt", "utf8");
    try {
      const resolved = resolveDefaultManualBootstrap({
        projectRoot,
        agentType: "claude-code",
        args: ["--append-system-prompt", customFile],
        env: {},
      });
      expect(resolved.mode).toBe("merged-system-prompt");
      expect(resolved.args).toEqual([
        "--append-system-prompt",
        expect.stringContaining(path.join("claude-code", "merged-bootstrap.md")),
      ]);
      expect(fs.readFileSync(resolved.file, "utf8")).toContain("custom prompt");
      expect(fs.readFileSync(resolved.file, "utf8")).toContain("ufoo ctx decisions -l");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("merges claude bootstrap into inline system prompt", () => {
    const resolved = resolveDefaultManualBootstrap({
      projectRoot: "/tmp/ufoo",
      agentType: "claude-code",
      args: ["--system-prompt", "custom prompt"],
      env: {},
    });
    expect(resolved.mode).toBe("merged-system-prompt");
    expect(resolved.args[0]).toBe("--system-prompt");
    expect(resolved.args[1]).toContain("custom prompt");
    expect(resolved.args[1]).toContain("ufoo ctx decisions -l");
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

  test("merges codex bootstrap into prompt args when a prompt is already present", () => {
    const resolved = resolveDefaultManualBootstrap({
      projectRoot: "/tmp/ufoo",
      agentType: "codex",
      args: ["fix the flaky test"],
      env: {},
    });
    expect(resolved.mode).toBe("initial-prompt-arg");
    expect(resolved.args[0]).toContain("Session bootstrap for Codex.");
    expect(resolved.args[0]).toContain("fix the flaky test");
  });

  test("keeps codex post-launch inject when args exist but no prompt positional is present", () => {
    const resolved = resolveDefaultManualBootstrap({
      projectRoot: "/tmp/ufoo",
      agentType: "codex",
      args: ["exec", "--json"],
      env: {},
    });
    expect(resolved.mode).toBe("post-launch-inject");
    expect(resolved.args).toEqual(["exec", "--json"]);
    expect(resolved.env.UFOO_STARTUP_BOOTSTRAP_TEXT).toContain("ufoo ctx decisions -l");
  });
});
