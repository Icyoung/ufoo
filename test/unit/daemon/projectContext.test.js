"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createProjectContext,
} = require("../../../src/runtime/daemon/projectContext");

describe("ProjectContext", () => {
  test("canonicalizes identity and deeply freezes project-owned inputs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-project-context-"));
    fs.mkdirSync(path.join(root, ".ufoo"), { recursive: true });
    try {
      const context = createProjectContext({
        projectRoot: `${root}/.`,
        config: {
          daemonTopology: "hybrid",
          nested: { projectOnly: true },
        },
        provider: "codex-cli",
        model: "gpt-test",
        runtimeGeneration: 4,
      });

      expect(context.projectRoot).toBe(fs.realpathSync(root));
      expect(context.projectId).toMatch(/^[a-f0-9]{12}$/);
      expect(context.paths.ufooDir).toBe(path.join(fs.realpathSync(root), ".ufoo"));
      expect(context.daemonTopology).toBe("hybrid");
      expect(context.runtimeGeneration).toBe(4);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.config)).toBe(true);
      expect(Object.isFrozen(context.config.nested)).toBe(true);
      expect(() => {
        context.config.nested.projectOnly = false;
      }).toThrow(TypeError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
