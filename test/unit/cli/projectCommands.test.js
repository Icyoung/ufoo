const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { upsertProjectRuntime } = require("../../../src/projects/registry");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const UFOO_BIN = path.join(REPO_ROOT, "bin", "ufoo.js");

function runCli(args = [], options = {}) {
  return spawnSync(process.execPath, [UFOO_BIN, ...args], {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

describe("cli project commands", () => {
  let sandboxRoot = "";
  let homeDir = "";
  let runtimeDir = "";
  let projectRoot = "";

  beforeEach(() => {
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cli-project-"));
    homeDir = path.join(sandboxRoot, "home");
    runtimeDir = path.join(homeDir, ".ufoo", "projects", "runtime");
    projectRoot = path.join(sandboxRoot, "workspace", "alpha");
    fs.mkdirSync(projectRoot, { recursive: true });

    upsertProjectRuntime({
      projectRoot,
      daemonPid: process.pid,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
      lastSeen: "2026-03-06T10:00:00.000Z",
    }, { runtimeDir });
  });

  afterEach(() => {
    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("project list --json outputs runtime entries", () => {
    const result = runCli(["project", "list", "--json"], {
      cwd: projectRoot,
      env: { HOME: homeDir },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout || "[]");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].project_root).toContain(path.join("workspace", "alpha"));
  });

  test("project current --json returns current cwd project context", () => {
    const result = runCli(["project", "current", "--json"], {
      cwd: projectRoot,
      env: { HOME: homeDir },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout || "{}");
    expect(parsed.project_root).toContain(path.join("workspace", "alpha"));
    expect(parsed.project_name).toBe("alpha");
  });

  test("project switch returns v1 chat-only contract", () => {
    const result = runCli(["project", "switch", "1"], {
      cwd: projectRoot,
      env: { HOME: homeDir },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("project switch is chat-only in v1");
  });
});
