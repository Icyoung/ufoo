"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createResourceLease } = require("../../../src/agents/runtime/tasks/resourceLease");
const { createWorkspaceAccess } = require("../../../src/coordination/state/workspaceAccess");
const { runCoreToolAsync } = require("../../../src/code/tools/executor");

describe("workspace writer coordination", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-resource-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  test("another process cannot acquire a live lease; dead owners are reclaimed", () => {
    const file = path.join(root, "leases.json");
    const lease = createResourceLease({ file });
    const held = lease.acquire({ key: root, ownerId: "main" });
    const modulePath = require.resolve("../../../src/agents/runtime/tasks/resourceLease");
    const execute = () => spawnSync(process.execPath, ["-e", `const lease=require(${JSON.stringify(modulePath)}).createResourceLease({file:process.argv[1]});process.stdout.write(JSON.stringify(lease.acquire({key:process.argv[2],ownerId:'child'})));`, file, root], { encoding: "utf8" });
    expect(JSON.parse(execute().stdout)).toMatchObject({ ok: false, code: "workspace_busy" });
    expect(lease.release({ key: root, token: "wrong" })).toBe(false);
    lease.release({ key: root, token: held.token });
    expect(JSON.parse(execute().stdout).ok).toBe(true);
    expect(lease.acquire({ key: root, ownerId: "main-again" }).ok).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  test("native ucode tools respect a task lease and external workers block main writes", async () => {
    const access = createWorkspaceAccess({ projectRoot: root, externalWriters: () => ["codex:worker"] });
    const key = fs.realpathSync(root);
    const held = access.leases.acquire({ key, ownerId: "child-run" });
    expect(await runCoreToolAsync({ workspaceRoot: root, sessionId: "ucode-other", tool: "write", args: { path: "blocked.txt", content: "bad" } })).toMatchObject({ ok: false, code: "workspace_busy" });
    expect(fs.existsSync(path.join(root, "blocked.txt"))).toBe(false);
    const effect = jest.fn();
    expect(await access.run({ workspaceRoot: root, taskRunId: "main", tool: "bash" }, effect)).toMatchObject({ ok: false, code: "workspace_busy" });
    expect(effect).not.toHaveBeenCalled();
    access.leases.release({ key, token: held.token });
    expect(await runCoreToolAsync({ workspaceRoot: root, sessionId: "ucode-other", tool: "write", args: { path: "allowed.txt", content: "ok" } })).toMatchObject({ ok: true });
  });
  test("a parent host and native ucode in a worktree share the directory lease", async () => {
    const worktree = path.join(root, "linked-worktree");
    fs.mkdirSync(worktree);
    const parent = createWorkspaceAccess({ projectRoot: root });
    const key = fs.realpathSync(worktree);
    const held = parent.leases.acquire({ key, ownerId: "child-worktree" });
    expect(await runCoreToolAsync({ workspaceRoot: worktree, sessionId: "native", tool: "write", args: { path: "file.txt", content: "bad" } })).toMatchObject({ ok: false, code: "workspace_busy" });
    expect(await runCoreToolAsync({ workspaceRoot: root, sessionId: "main", tool: "write", args: { path: "independent.txt", content: "ok" } })).toMatchObject({ ok: true });
    parent.leases.release({ key, token: held.token });
    expect(await runCoreToolAsync({ workspaceRoot: worktree, sessionId: "native", tool: "write", args: { path: "file.txt", content: "ok" } })).toMatchObject({ ok: true });
  });
});
