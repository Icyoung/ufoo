const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/bus", () => jest.fn());
jest.mock("../../../src/agent/ucodeBootstrap", () => ({
  prepareUcodeBootstrap: jest.fn(),
}));

const EventBus = require("../../../src/bus");
const { prepareUcodeBootstrap } = require("../../../src/agent/ucodeBootstrap");
const { createGroupOrchestrator } = require("../../../src/daemon/groupOrchestrator");
const { getUfooPaths } = require("../../../src/ufoo/paths");

const TEST_ROOT = path.join(os.tmpdir(), "ufoo-group-orchestrator-test");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeProjectConfig(projectRoot, data) {
  writeJson(path.join(projectRoot, ".ufoo", "config.json"), data);
}

function upsertAgentMeta(projectRoot, subscriberId, patch) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const current = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : { schema_version: 1, created_at: new Date().toISOString(), agents: {} };
  current.agents = current.agents || {};
  current.agents[subscriberId] = {
    ...(current.agents[subscriberId] || {}),
    ...patch,
  };
  writeJson(filePath, current);
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
        role: "task coordinator",
        prompt_profile: "task-breakdown",
        startup_order: 1,
        depends_on: [],
        accept_from: [],
        report_to: ["architect"],
      },
      {
        id: "architect",
        nickname: "architect",
        type: "claude",
        role: "system architect",
        prompt_profile: "architecture-review",
        startup_order: 2,
        depends_on: ["pm"],
        accept_from: ["pm"],
        report_to: [],
      },
    ],
    edges: [{ from: "pm", to: "architect", kind: "task" }],
  };
}

function buildUcodeTemplate(alias = "ucode-group") {
  return {
    schema_version: 1,
    template: {
      id: alias,
      alias,
      name: alias,
    },
    agents: [
      {
        id: "ucode",
        nickname: "ucode",
        type: "ucode",
        role: "prototype",
        prompt_profile: "rapid-prototype",
        startup_order: 1,
        depends_on: [],
        accept_from: [],
        report_to: [],
      },
    ],
    edges: [],
  };
}

describe("daemon groupOrchestrator", () => {
  const projectRoot = path.join(TEST_ROOT, "project");
  const builtinDir = path.join(TEST_ROOT, "builtin");
  const globalDir = path.join(TEST_ROOT, "global");
  const projectDir = path.join(projectRoot, ".ufoo", "templates", "groups");
  const runtimeNick = (nickname) => `project-${nickname}`;
  let injectMock;

function createTestOrchestrator(handleOps) {
    return createGroupOrchestrator({
      projectRoot,
      handleOps,
      templatesOptions: { builtinDir, globalDir, projectDir },
      bootstrapTimeoutMs: 25,
      bootstrapRetryDelayMs: 1,
      bootstrapProtectionMs: 3,
      bootstrapWorkingGraceMs: 8,
    });
  }

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(path.join(builtinDir, "dev-basic.json"), buildTemplate("dev-basic"));
    writeJson(path.join(builtinDir, "ucode-group.json"), buildUcodeTemplate("ucode-group"));
    writeJson(getUfooPaths(projectRoot).agentsFile, {
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {},
    });

    injectMock = jest.fn().mockResolvedValue(undefined);
    EventBus.mockReset();
    EventBus.mockImplementation(() => ({ inject: injectMock }));
    prepareUcodeBootstrap.mockReset();
    prepareUcodeBootstrap.mockImplementation(({ targetFile }) => ({
      ok: true,
      file: targetFile,
    }));
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("runGroup supports dry-run and exposes resolved bootstrap metadata", async () => {
    const handleOps = jest.fn();
    const orchestrator = createTestOrchestrator(handleOps);

    const result = await orchestrator.runGroup({ alias: "dev-basic", dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.status).toBe("dry_run");
    expect(Array.isArray(result.members)).toBe(true);
    expect(result.members).toHaveLength(2);
    expect(result.members[0]).toEqual(
      expect.objectContaining({
        nickname: "pm",
        scoped_nickname: runtimeNick("pm"),
        resolved_profile: "task-breakdown",
        bootstrap_strategy: "initial-prompt-arg",
      })
    );
    expect(result.members[1]).toEqual(
      expect.objectContaining({
        nickname: "architect",
        scoped_nickname: runtimeNick("architect"),
        bootstrap_strategy: "system-prompt-file",
      })
    );
    expect(result.members[1].group_members).toHaveLength(2);
    expect(handleOps).not.toHaveBeenCalled();
  });

  test("runGroup launches members, injects bootstrap prompts, and persists runtime state", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "launch" && op.nickname === runtimeNick("architect")) {
        upsertAgentMeta(projectRoot, "claude-code:arch1", {
          nickname: runtimeNick("architect"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:arch1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);

    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-dev" });
    expect(result.ok).toBe(true);
    expect(result.group_id).toBe("grp-dev");
    expect(result.group.status).toBe("active");
    expect(result.group.members.map((item) => item.status)).toEqual(["active", "active"]);
    // Both codex (initial-prompt-arg) and claude (system-prompt-file) skip inject
    expect(injectMock).toHaveBeenCalledTimes(0);

    const runtimeFile = path.join(getUfooPaths(projectRoot).groupsDir, "grp-dev.json");
    expect(fs.existsSync(runtimeFile)).toBe(true);
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    expect(runtime.status).toBe("active");
    expect(runtime.roster_version).toBeTruthy();
    expect(runtime.members[0]).toEqual(
      expect.objectContaining({
        subscriber_id: "codex:pm1",
        scoped_nickname: runtimeNick("pm"),
        bootstrap_status: "applied",
        bootstrapped_subscriber_id: "codex:pm1",
        resolved_profile: "task-breakdown",
      })
    );
    expect(runtime.members[1]).toEqual(
      expect.objectContaining({
        subscriber_id: "claude-code:arch1",
        scoped_nickname: runtimeNick("architect"),
        bootstrap_status: "applied",
        upstream: ["pm"],
      })
    );
  });

  test("runGroup forwards host launch context to member launches", async () => {
    const handleOps = jest.fn(async () => {
      upsertAgentMeta(projectRoot, "codex:pm1", {
        nickname: "pm",
        status: "active",
        activity_state: "ready",
      });
      return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "host" }];
    });
    const orchestrator = createTestOrchestrator(handleOps);

    await orchestrator.runGroup({
      alias: "dev-basic",
      instance: "grp-host",
      host_inject_sock: "/tmp/host-inject.sock",
      host_daemon_sock: "/tmp/host-daemon.sock",
      host_name: "horizon",
      host_session_id: "HS123",
      host_capabilities: { supportsSnapshot: true },
    });

    expect(handleOps).toHaveBeenNthCalledWith(
      1,
      projectRoot,
      [expect.objectContaining({
        action: "launch",
        nickname: runtimeNick("pm"),
        host_inject_sock: "/tmp/host-inject.sock",
        host_daemon_sock: "/tmp/host-daemon.sock",
        host_name: "horizon",
        host_session_id: "HS123",
        host_capabilities: { supportsSnapshot: true },
      })],
      null
    );
  });

  test("runGroup reuses one tmux layout context across member launches", async () => {
    const tmuxContexts = [];
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      tmuxContexts.push(op.tmux_layout_context);
      if (op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "tmux" }];
      }
      upsertAgentMeta(projectRoot, "claude-code:arch1", {
        nickname: runtimeNick("architect"),
        status: "active",
        activity_state: "ready",
      });
      return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:arch1"], mode: "tmux" }];
    });
    const orchestrator = createTestOrchestrator(handleOps);

    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-tmux-layout" });

    expect(result.ok).toBe(true);
    expect(tmuxContexts).toHaveLength(2);
    expect(tmuxContexts[0]).toBe(tmuxContexts[1]);
    expect(tmuxContexts[0]).toEqual(expect.objectContaining({ mode: "group-right-column" }));
  });

  test("runGroup rolls back launched members when a later launch fails", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "launch" && op.nickname === runtimeNick("architect")) {
        return [{ action: "launch", ok: false, error: "boom" }];
      }
      if (op.action === "close" && op.agent_id === "codex:pm1") {
        return [{ action: "close", ok: true, agent_id: "codex:pm1" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);

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

  test("runGroup rolls back when claude system-prompt-file bootstrap write fails", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "close" && op.agent_id === "codex:pm1") {
        return [{ action: "close", ok: true, agent_id: "codex:pm1" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    // Make the bootstrap file directory unwritable to trigger system-prompt-file failure
    const groupsDir = path.join(getUfooPaths(projectRoot).agentDir, "ucode", "groups", "grp-bootstrap-fail");
    fs.mkdirSync(groupsDir, { recursive: true });
    // Create a file where the directory should be, so mkdirSync fails
    const architectBootstrapDir = path.join(groupsDir, "architect.bootstrap.md");
    fs.mkdirSync(architectBootstrapDir, { recursive: true });
    fs.writeFileSync(path.join(architectBootstrapDir, "blocker"), "x");

    const orchestrator = createTestOrchestrator(handleOps);

    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-bootstrap-fail" });
    expect(result.ok).toBe(false);

    const runtime = JSON.parse(
      fs.readFileSync(path.join(getUfooPaths(projectRoot).groupsDir, "grp-bootstrap-fail.json"), "utf8")
    );
    expect(runtime.status).toBe("failed");
  });

  test("runGroup re-injects bootstrap for reused post-launch members when no matching bootstrap record exists", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "idle",
        });
        return [{
          action: "launch",
          ok: true,
          agent_id: "codex:pm1",
          skipped: true,
          message: "Agent 'pm' already exists",
        }];
      }
      if (op.action === "launch" && op.nickname === runtimeNick("architect")) {
        upsertAgentMeta(projectRoot, "claude-code:arch1", {
          nickname: runtimeNick("architect"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:arch1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);
    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-reused-ok" });

    expect(result.ok).toBe(true);
    expect(result.group.members[0]).toEqual(
      expect.objectContaining({
        nickname: "pm",
        scoped_nickname: runtimeNick("pm"),
        status: "reused",
        bootstrap_status: "applied",
        bootstrapped_subscriber_id: "codex:pm1",
        bootstrap_fingerprint: expect.any(String),
      })
    );
    // Both codex (initial-prompt-arg) and claude (system-prompt-file) skip inject
    expect(injectMock).toHaveBeenCalledTimes(0);
    expect(result.group.members[1]).toEqual(
      expect.objectContaining({
        nickname: "architect",
        scoped_nickname: runtimeNick("architect"),
        bootstrap_status: "applied",
      })
    );
  });

  test("runGroup prepares ucode bootstrap files and forwards launch env", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch") {
        return [{ action: "launch", ok: true, subscriber_ids: ["ufoo-code:uc1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);

    const result = await orchestrator.runGroup({ alias: "ucode-group", instance: "grp-ucode" });
    expect(result.ok).toBe(true);
    expect(prepareUcodeBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        targetFile: expect.stringContaining(path.join("ucode", "groups", "grp-ucode", "ucode.bootstrap.md")),
        promptText: expect.stringContaining("rapid prototype lead"),
      })
    );
    expect(handleOps).toHaveBeenCalledWith(
      projectRoot,
      [expect.objectContaining({
        action: "launch",
        extra_env: expect.objectContaining({
          UFOO_UCODE_BOOTSTRAP_FILE: expect.stringContaining("ucode.bootstrap.md"),
        }),
      })],
      null
    );
    expect(injectMock).not.toHaveBeenCalled();
  });

  test("runGroup resolves auto agent types from the current ufoo provider", async () => {
    writeJson(path.join(builtinDir, "auto-group.json"), {
      schema_version: 1,
      template: {
        id: "auto-group",
        alias: "auto-group",
        name: "auto-group",
      },
      agents: [
        {
          id: "lead",
          nickname: "lead",
          type: "auto",
          role: "ship work",
          prompt_profile: "implementation-lead",
          startup_order: 1,
          depends_on: [],
          accept_from: [],
          report_to: [],
        },
      ],
      edges: [],
    });
    writeProjectConfig(projectRoot, { agentProvider: "claude-cli" });

    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch") {
        upsertAgentMeta(projectRoot, "claude-code:auto1", {
          nickname: runtimeNick("lead"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:auto1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);
    const result = await orchestrator.runGroup({ alias: "auto-group", instance: "grp-auto-provider" });

    expect(result.ok).toBe(true);
    expect(handleOps).toHaveBeenCalledWith(
      projectRoot,
      [expect.objectContaining({
        action: "launch",
        agent: "claude",
        nickname: runtimeNick("lead"),
      })],
      null
    );
    expect(result.group.members[0]).toEqual(
      expect.objectContaining({
        requested_type: "auto",
        type: "claude",
        subscriber_id: "claude-code:auto1",
      })
    );
  });

  test("runGroup waits for startup to settle before bootstrap inject", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "working",
        });
        setTimeout(() => {
          upsertAgentMeta(projectRoot, "codex:pm1", {
            nickname: "pm",
            status: "active",
            activity_state: "idle",
          });
        }, 5);
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "launch" && op.nickname === runtimeNick("architect")) {
        upsertAgentMeta(projectRoot, "claude-code:arch1", {
          nickname: runtimeNick("architect"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:arch1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);
    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-wait-ready" });

    expect(result.ok).toBe(true);
    // codex uses initial-prompt-arg, claude uses system-prompt-file — no inject
    expect(injectMock).toHaveBeenCalledTimes(0);
  });

  test("runGroup uses system-prompt-file strategy for claude (no inject, no settle delay)", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("lead")) {
        upsertAgentMeta(projectRoot, "claude-code:lead1", {
          nickname: runtimeNick("lead"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:lead1"], mode: "host" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    writeJson(path.join(builtinDir, "single-claude.json"), {
      schema_version: 1,
      template: { id: "single-claude", alias: "single-claude", name: "single-claude" },
      agents: [{
        id: "lead",
        nickname: "lead",
        type: "claude",
        role: "lead",
        prompt_profile: "system-architect",
        startup_order: 1,
        depends_on: [],
        accept_from: [],
        report_to: [],
      }],
      edges: [],
    });

    const orchestrator = createGroupOrchestrator({
      projectRoot,
      handleOps,
      templatesOptions: { builtinDir, globalDir, projectDir },
      bootstrapTimeoutMs: 80,
      bootstrapRetryDelayMs: 1,
      bootstrapProtectionMs: 3,
      bootstrapWorkingGraceMs: 8,
      bootstrapInjectSettleMsByAgent: { claude: 20 },
    });

    const result = await orchestrator.runGroup({ alias: "single-claude", instance: "grp-claude-settle" });

    expect(result.ok).toBe(true);
    // system-prompt-file: no inject needed, bootstrap baked into --append-system-prompt
    expect(injectMock).toHaveBeenCalledTimes(0);
    expect(handleOps).toHaveBeenCalledWith(
      projectRoot,
      [expect.objectContaining({
        action: "launch",
        nickname: runtimeNick("lead"),
        extra_args: ["--append-system-prompt", expect.stringContaining("lead")],
      })],
      null
    );
    expect(result.group.members[0]).toEqual(
      expect.objectContaining({
        bootstrap_status: "applied",
        subscriber_id: "claude-code:lead1",
      })
    );
  });

  test("runGroup allows bootstrap after prolonged working state", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "launch" && op.nickname === runtimeNick("pm")) {
        upsertAgentMeta(projectRoot, "codex:pm1", {
          nickname: runtimeNick("pm"),
          status: "active",
          activity_state: "working",
          activity_since: new Date(Date.now() - 20).toISOString(),
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["codex:pm1"], mode: "internal" }];
      }
      if (op.action === "launch" && op.nickname === runtimeNick("architect")) {
        upsertAgentMeta(projectRoot, "claude-code:arch1", {
          nickname: runtimeNick("architect"),
          status: "active",
          activity_state: "ready",
        });
        return [{ action: "launch", ok: true, subscriber_ids: ["claude-code:arch1"], mode: "internal" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const orchestrator = createTestOrchestrator(handleOps);
    const result = await orchestrator.runGroup({ alias: "dev-basic", instance: "grp-working-grace" });

    expect(result.ok).toBe(true);
    // codex uses initial-prompt-arg, claude uses system-prompt-file — no inject
    expect(injectMock).toHaveBeenCalledTimes(0);
    expect(result.group.members[0]).toEqual(
      expect.objectContaining({
        nickname: "pm",
        scoped_nickname: runtimeNick("pm"),
        bootstrap_status: "applied",
        subscriber_id: "codex:pm1",
      })
    );
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

    const orchestrator = createTestOrchestrator(handleOps);

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

    const orchestrator = createTestOrchestrator(async () => []);

    const list = orchestrator.getStatus({});
    expect(list.ok).toBe(true);
    expect(list.count).toBe(2);
    expect(list.groups[0].group_id).toBe("one");

    const single = orchestrator.getStatus({ group_id: "two" });
    expect(single.ok).toBe(true);
    expect(single.group.group_id).toBe("two");
  });

  test("rejects invalid group_id for status and stop", async () => {
    const orchestrator = createTestOrchestrator(async () => []);

    const statusResult = orchestrator.getStatus({ group_id: "../outside" });
    expect(statusResult.ok).toBe(false);
    expect(statusResult.error).toBe("invalid group_id");

    const stopResult = await orchestrator.stopGroup({ group_id: "../outside" });
    expect(stopResult.ok).toBe(false);
    expect(stopResult.error).toBe("invalid group_id");
    expect(stopResult.status).toBe("failed");
  });
});
