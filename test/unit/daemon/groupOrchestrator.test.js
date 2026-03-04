const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGroupOrchestrator } = require("../../../src/daemon/groupOrchestrator");
const { getUfooPaths } = require("../../../src/ufoo/paths");

const TEST_ROOT = path.join(os.tmpdir(), "ufoo-group-orchestrator-test");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function buildTemplate(alias = "dev-basic") {
  return {
    schema_version: 1,
    template: {
      id: alias,
      alias,
      name: alias,
    },
    agents: [
      {
        id: "pm",
        nickname: "pm",
        type: "codex",
        startup_order: 1,
        depends_on: [],
        accept_from: [],
        report_to: [],
      },
      {
        id: "architect",
        nickname: "architect",
        type: "claude",
        startup_order: 2,
        depends_on: ["pm"],
        accept_from: ["pm"],
        report_to: ["pm"],
      },
    ],
    edges: [{ from: "pm", to: "architect", kind: "task" }],
  };
}

describe("daemon groupOrchestrator", () => {
  const projectRoot = path.join(TEST_ROOT, "project");
  const builtinDir = path.join(TEST_ROOT, "builtin");
  const globalDir = path.join(TEST_ROOT, "global");
  const projectDir = path.join(projectRoot, ".ufoo", "templates", "groups");

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(path.join(builtinDir, "dev-basic.json"), buildTemplate("dev-basic"));
    writeJson(getUfooPaths(projectRoot).agentsFile, {
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {},
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("runGroup supports dry-run without launching agents", async () => {
    const handleOps = jest.fn();
    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps,
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const result = await orchestrator.runGroup({ alias: "dev-basic", dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.status).toBe("dry_run");
    expect(Array.isArray(result.members)).toBe(true);
    expect(result.members).toHaveLength(2);
    expect(handleOps).not.toHaveBeenCalled();
  });

  test("runGroup launches members and persists active runtime state", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === "pm") {
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "launch" && op.nickname === "architect") {
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:arch1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps,
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-dev" });
    expect(result.ok).toBe(true);
    expect(result.group_id).toBe("grp-dev");
    expect(result.group.status).toBe("active");
    expect(result.group.members.map((item) => item.status)).toEqual(["active", "active"]);

    const runtimeFile = path.join(getUfooPaths(projectRoot).groupsDir, "grp-dev.json");
    expect(fs.existsSync(runtimeFile)).toBe(true);
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    expect(runtime.status).toBe("active");
    expect(runtime.members[0].subscriber_id).toBe("codex:pm1");
    expect(runtime.members[1].subscriber_id).toBe("claude-code:arch1");
  });

  test("runGroup rolls back launched members when a later launch fails", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === "pm") {
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "launch" && op.nickname === "architect") {
        return [{ action: "launch", ok: false, error: "boom" }];
      }
      if (op.action === "close" && op.agent_id === "codex:pm1") {
        return [{ action: "close", ok: true, agent_id: "codex:pm1" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps,
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-fail" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(handleOps).toHaveBeenCalledWith(projectRoot, [{ action: "close", agent_id: "codex:pm1" }], null);

    const runtimeFile = path.join(getUfooPaths(projectRoot).groupsDir, "grp-fail.json");
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    expect(runtime.status).toBe("failed");
    expect(runtime.members[0].status).toBe("rolled_back");
    expect(runtime.members[1].status).toBe("failed");
  });

  test("stopGroup stops only managed active members in reverse order", async () => {
    const runtime = {
      group_id: "grp-stop",
      status: "active",
      template_alias: "dev-basic",
      template_version: 1,
      updated_at: new Date().toISOString(),
      members: [
        { nickname: "a", status: "active", managed: true, subscriber_id: "codex:a1" },
        { nickname: "b", status: "reused", managed: false, subscriber_id: "codex:b1" },
        { nickname: "c", status: "active", managed: true, subscriber_id: "codex:c1" },
      ],
      errors: [],
    };
    writeJson(path.join(getUfooPaths(projectRoot).groupsDir, "grp-stop.json"), runtime);

    const closeOrder = [];
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "close") {
        closeOrder.push(op.agent_id);
        return [{ action: "close", ok: true, agent_id: op.agent_id }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps,
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const result = await orchestrator.stopGroup({ group_id: "grp-stop" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("stopped");
    expect(closeOrder).toEqual(["codex:c1", "codex:a1"]);
  });

  test("getStatus lists summary and resolves single group", async () => {
    writeJson(path.join(getUfooPaths(projectRoot).groupsDir, "one.json"), {
      group_id: "one",
      status: "active",
      template_alias: "dev-basic",
      updated_at: "2026-03-03T00:00:00.000Z",
      members: [{ status: "active" }, { status: "reused" }],
    });
    writeJson(path.join(getUfooPaths(projectRoot).groupsDir, "two.json"), {
      group_id: "two",
      status: "failed",
      template_alias: "dev-basic",
      updated_at: "2026-03-02T00:00:00.000Z",
      members: [{ status: "failed" }],
    });

    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps: async () => [],
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const list = orchestrator.getStatus({});
    expect(list.ok).toBe(true);
    expect(list.count).toBe(2);
    expect(list.groups[0].group_id).toBe("one");

    const single = orchestrator.getStatus({ group_id: "two" });
    expect(single.ok).toBe(true);
    expect(single.group.group_id).toBe("two");
  });

  test("rejects invalid group_id for status and stop", async () => {
    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps: async () => [],
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const statusResult = orchestrator.getStatus({ group_id: "../outside" });
    expect(statusResult.ok).toBe(false);
    expect(statusResult.error).toBe("invalid group_id");

    const stopResult = await orchestrator.stopGroup({ group_id: "../outside" });
    expect(stopResult.ok).toBe(false);
    expect(stopResult.error).toBe("invalid group_id");
    expect(stopResult.status).toBe("failed");
  });
});
