const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { canonicalProjectRoot, buildProjectId } = require("../../../src/runtime/projects/projectId");
const {
  upsertProjectRuntime,
  markProjectDormant,
  markProjectStopped,
  listProjectRuntimes,
  getCurrentProjectRuntime,
  validateProjectRuntime,
  archiveMissingProjectRuntimes,
} = require("../../../src/runtime/projects/registry");

describe("projects registry", () => {
  let sandboxRoot = "";
  let runtimeDir = "";
  let projectRoot = "";

  beforeEach(() => {
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-project-registry-"));
    runtimeDir = path.join(sandboxRoot, "home", ".ufoo", "projects", "runtime");
    projectRoot = path.join(sandboxRoot, "workspace", "alpha");
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    if (sandboxRoot && fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  test("buildProjectId is stable for equivalent paths", () => {
    const withDot = path.join(projectRoot, ".");
    expect(buildProjectId(projectRoot)).toBe(buildProjectId(withDot));
    expect(canonicalProjectRoot(projectRoot)).toBe(canonicalProjectRoot(`${projectRoot}/`));
  });

  test("upsert and read current runtime", () => {
    const entry = upsertProjectRuntime({
      projectRoot,
      daemonPid: process.pid,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
      lastSeen: "2026-03-06T10:00:00.000Z",
    }, { runtimeDir });

    expect(entry.project_root).toBe(canonicalProjectRoot(projectRoot));
    expect(entry.project_id).toBe(buildProjectId(projectRoot));

    const current = getCurrentProjectRuntime(projectRoot, { runtimeDir, validate: false });
    expect(current).not.toBeNull();
    expect(current.project_id).toBe(entry.project_id);
    expect(current.status).toBe("running");
  });

  test("markProjectStopped updates status to stopped", () => {
    upsertProjectRuntime({
      projectRoot,
      daemonPid: process.pid,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
    }, { runtimeDir });

    const stopped = markProjectStopped(projectRoot, { runtimeDir });
    expect(stopped.status).toBe("stopped");

    const current = getCurrentProjectRuntime(projectRoot, { runtimeDir, validate: false });
    expect(current.status).toBe("stopped");
  });

  test("dormant runtime remains registered without a compatibility socket", () => {
    upsertProjectRuntime({
      projectRoot,
      daemonPid: process.pid,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
    }, { runtimeDir });

    const dormant = markProjectDormant(projectRoot, { runtimeDir });
    const validated = validateProjectRuntime(dormant, {
      staleTtlMs: 1,
      nowMs: Date.now() + 10000,
    });

    expect(validated.status).toBe("dormant");
    expect(validated.validation.pid_alive).toBe(true);
    expect(validated.validation.socket_alive).toBe(false);
  });

  test("upsert preserves existing fields when partial updates are provided", () => {
    const base = upsertProjectRuntime({
      projectRoot,
      daemonPid: process.pid,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
      lastSeen: "2026-03-06T10:00:00.000Z",
    }, { runtimeDir });

    const updated = upsertProjectRuntime({
      projectRoot,
      status: "stale",
    }, { runtimeDir });

    expect(updated.project_id).toBe(base.project_id);
    expect(updated.socket_path).toBe(base.socket_path);
    expect(updated.daemon_pid).toBe(base.daemon_pid);
    expect(updated.status).toBe("stale");
  });

  test("listProjectRuntimes tolerates malformed files", () => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "broken.json"), "{bad-json\n", "utf8");
    upsertProjectRuntime({
      projectRoot,
      daemonPid: process.pid,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
      lastSeen: "2026-03-06T10:00:00.000Z",
    }, { runtimeDir });

    const rows = listProjectRuntimes({ runtimeDir, validate: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(buildProjectId(projectRoot));
  });

  test("archives only old deleted workspaces without a live runtime, retaining original records", () => {
    const gone = path.join(sandboxRoot, "deleted");
    const old = { daemonPid: 99999999, lastSeen: "2026-01-01T00:00:00Z" };
    fs.mkdirSync(gone);
    const missing = upsertProjectRuntime({ projectRoot: gone, ...old }, { runtimeDir });
    fs.rmdirSync(gone);
    upsertProjectRuntime({ projectRoot, status: "dormant", ...old }, { runtimeDir });
    for (const [name, entry] of [["live-deleted", { ...old, daemonPid: process.pid }], ["recent-deleted", { daemonPid: 99999999 }]]) {
      const root = path.join(sandboxRoot, name);
      fs.mkdirSync(root);
      upsertProjectRuntime({ projectRoot: root, ...entry }, { runtimeDir });
      fs.rmdirSync(root);
    }
    const preview = archiveMissingProjectRuntimes({ runtimeDir });
    expect(preview.count).toBe(1);
    expect(listProjectRuntimes({ runtimeDir })).toHaveLength(4);
    const result = archiveMissingProjectRuntimes({ runtimeDir, dryRun: false });
    expect(result.projects.map((row) => row.project_id)).toEqual([missing.project_id]);
    expect(listProjectRuntimes({ runtimeDir })).toHaveLength(3);
    const original = JSON.parse(fs.readFileSync(path.join(result.archive_dir, `${missing.project_id}.json`), "utf8"));
    expect(original.project_root).toBe(missing.project_root);
  });

  test("validation marks stale when heartbeat exceeded and endpoint unavailable", () => {
    upsertProjectRuntime({
      projectRoot,
      daemonPid: 999999,
      socketPath: path.join(projectRoot, ".ufoo", "run", "ufoo.sock"),
      status: "running",
      lastSeen: "2026-03-06T10:00:00.000Z",
    }, { runtimeDir });

    const rows = listProjectRuntimes({
      runtimeDir,
      validate: true,
      staleTtlMs: 1000,
      nowMs: Date.parse("2026-03-06T10:00:10.000Z"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("stale");
    expect(rows[0].validation.pid_alive).toBe(false);
    expect(rows[0].validation.socket_alive).toBe(false);
  });

  test("validation upgrades to running when pid and socket are alive", async () => {
    const socketPath = path.join(sandboxRoot, "ufoo.sock");
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore
    }
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const base = upsertProjectRuntime({
        projectRoot,
        daemonPid: process.pid,
        socketPath,
        status: "stale",
        lastSeen: "2026-03-06T10:00:00.000Z",
      }, { runtimeDir });

      const validated = validateProjectRuntime(base, {
        staleTtlMs: 1,
        nowMs: Date.parse("2026-03-06T10:00:10.000Z"),
      });
      expect(validated.status).toBe("running");
      expect(validated.validation.pid_alive).toBe(true);
      expect(validated.validation.socket_alive).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
