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

  test("explicit resource leases prevent concurrent acquisition by another live process and reclaim dead owners", () => {
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

  test("shared-repo ucode tools and workspace access allow parallel non-overlapping edits without whole-repo workspace_busy", async () => {
    const access = createWorkspaceAccess({ projectRoot: root });
    const key = fs.realpathSync(root);
    const held = access.leases.acquire({ key, ownerId: "other-agent" });
    try {
      expect(await runCoreToolAsync({ workspaceRoot: root, sessionId: "ucode-a", tool: "write", args: { path: "module-a.txt", content: "a" } })).toMatchObject({ ok: true });
      expect(await runCoreToolAsync({ workspaceRoot: root, sessionId: "ucode-b", tool: "write", args: { path: "module-b.txt", content: "b" } })).toMatchObject({ ok: true });
      expect(fs.readFileSync(path.join(root, "module-a.txt"), "utf8")).toBe("a");
      expect(fs.readFileSync(path.join(root, "module-b.txt"), "utf8")).toBe("b");
      const effect = jest.fn().mockResolvedValue({ ok: true });
      expect(await access.run({ workspaceRoot: root, taskRunId: "main", tool: "bash", args: { command: "npm test" } }, effect)).toMatchObject({ ok: true });
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      access.leases.release({ key, token: held.token });
    }
  });
});
