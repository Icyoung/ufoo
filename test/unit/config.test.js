const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveConfig, loadConfig } = require("../../src/config");

describe("config save/load", () => {
  test("saveConfig preserves existing fields on partial updates", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, { launchMode: "internal" });
    saveConfig(projectRoot, { assistantEngine: "codex" });

    const loaded = loadConfig(projectRoot);
    expect(loaded.launchMode).toBe("internal");
    expect(loaded.assistantEngine).toBe("codex");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("saveConfig preserves host launch mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-host-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, { launchMode: "host" });

    const loaded = loadConfig(projectRoot);
    expect(loaded.launchMode).toBe("host");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});
