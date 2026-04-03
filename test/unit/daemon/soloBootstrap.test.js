"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/bus", () => jest.fn());
jest.mock("../../../src/agent/ucodeBootstrap", () => ({
  prepareUcodeBootstrap: jest.fn(() => ({ ok: true, file: "/tmp/bootstrap.md" })),
}));

const EventBus = require("../../../src/bus");
const { prepareUcodeBootstrap } = require("../../../src/agent/ucodeBootstrap");
const { getUfooPaths } = require("../../../src/ufoo/paths");
const { buildProjectNicknamePrefix } = require("../../../src/daemon/nicknameScope");
const {
  resolveSoloPromptProfile,
  buildSoloBootstrap,
  waitForSoloBootstrapReady,
  injectSoloBootstrapPrompt,
  prepareSoloUcodeBootstrap,
  resolveExistingAgent,
  findOwningGroup,
  rollbackLaunchAfterRoleAssignmentFailure,
  assignSoloRoleToExistingAgent,
} = require("../../../src/daemon/soloBootstrap");

describe("daemon soloBootstrap", () => {
  let projectRoot;
  let runtimeNick;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-solo-bootstrap-"));
    runtimeNick = (nickname) => `${buildProjectNicknamePrefix(projectRoot)}-${nickname}`;
    const paths = getUfooPaths(projectRoot);
    fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {
        "codex:test": {
          agent_type: "codex",
          nickname: "designer",
          status: "active",
          activity_state: "ready",
          last_seen: new Date().toISOString(),
        },
      },
    }, null, 2));
    EventBus.mockReset();
    EventBus.mockImplementation(() => ({
      inject: jest.fn().mockResolvedValue(undefined),
    }));
    prepareUcodeBootstrap.mockClear();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("resolves prompt profile from registry", () => {
    const resolved = resolveSoloPromptProfile(projectRoot, "frontend-refiner");
    expect(resolved.ok).toBe(true);
    expect(resolved.profile.id).toBe("frontend-refiner");
  });

  test("builds solo bootstrap prompt with metadata", () => {
    const resolved = resolveSoloPromptProfile(projectRoot, "design-critic");
    const built = buildSoloBootstrap({
      nickname: "designer",
      agentType: "codex",
      requestedProfile: "design-critic",
      profile: resolved.profile,
    });

    expect(built.required).toBe(true);
    expect(built.promptText).toContain("You are the design critic");
    expect(built.promptText).toContain("ufoo ctx decisions -l");
    expect(built.promptText).toContain("ufoo bus send <target-nickname>");
    expect(built.promptText).toContain("ufoo bus ack \"$UFOO_SUBSCRIBER_ID\"");
    expect(built.promptText).toContain("\"self_nickname\": \"designer\"");
    expect(built.promptText).toContain("\"resolved_profile\": \"design-critic\"");
  });

  test("injects solo bootstrap after ready state", async () => {
    const resolved = resolveSoloPromptProfile(projectRoot, "frontend-refiner");
    const built = buildSoloBootstrap({
      nickname: "refiner",
      agentType: "codex",
      requestedProfile: "frontend-refiner",
      profile: resolved.profile,
    });
    const result = await injectSoloBootstrapPrompt(projectRoot, "codex:test", built.promptText, {
      timeoutMs: 20,
      retryDelayMs: 1,
      protectionMs: 1,
      workingGraceMs: 5,
    });

    expect(result.ok).toBe(true);
    const instance = EventBus.mock.results[0].value;
    expect(instance.inject).toHaveBeenCalledWith("codex:test", expect.stringContaining("frontend refiner"));
  });

  test("prepares ucode bootstrap file from solo prompt", () => {
    const result = prepareSoloUcodeBootstrap(projectRoot, "designer", "hello");
    expect(result.ok).toBe(true);
    expect(prepareUcodeBootstrap).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot,
      promptText: "hello",
    }));
  });

  test("resolves existing agent by nickname", () => {
    const resolved = resolveExistingAgent(projectRoot, "designer");
    expect(resolved.subscriberId).toBe("codex:test");
  });

  test("resolves existing agent by raw nickname when runtime nickname is project-prefixed", () => {
    fs.writeFileSync(getUfooPaths(projectRoot).agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {
        "codex:test": {
          agent_type: "codex",
          nickname: runtimeNick("designer"),
          status: "active",
          activity_state: "ready",
          last_seen: new Date().toISOString(),
        },
      },
    }, null, 2));

    const resolved = resolveExistingAgent(projectRoot, "designer");
    expect(resolved.subscriberId).toBe("codex:test");
  });

  test("does not resolve stale active agent entries as existing live agents", () => {
    fs.writeFileSync(getUfooPaths(projectRoot).agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {
        "codex:test": {
          agent_type: "codex",
          nickname: "designer",
          status: "active",
          activity_state: "ready",
          last_seen: new Date(Date.now() - (31 * 1000)).toISOString(),
          joined_at: new Date(Date.now() - (31 * 1000)).toISOString(),
        },
      },
    }, null, 2));

    expect(resolveExistingAgent(projectRoot, "designer")).toBeNull();
    expect(resolveExistingAgent(projectRoot, "codex:test")).toBeNull();
  });

  test("detects active group ownership for subscriber", () => {
    const groupPath = path.join(getUfooPaths(projectRoot).groupsDir, "grp-1.json");
    fs.mkdirSync(path.dirname(groupPath), { recursive: true });
    fs.writeFileSync(groupPath, JSON.stringify({
      group_id: "grp-1",
      template_alias: "ui-polish",
      status: "active",
      members: [
        {
          nickname: "designer",
          subscriber_id: "codex:test",
          status: "active",
        },
      ],
    }, null, 2));

    const owner = findOwningGroup(projectRoot, "codex:test");
    expect(owner.group_id).toBe("grp-1");
  });

  test("detects active group ownership when live nickname uses runtime_nickname", () => {
    fs.writeFileSync(getUfooPaths(projectRoot).agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {
        "codex:test": {
          agent_type: "codex",
          nickname: runtimeNick("designer"),
          status: "active",
          activity_state: "ready",
          last_seen: new Date().toISOString(),
        },
      },
    }, null, 2));
    const groupPath = path.join(getUfooPaths(projectRoot).groupsDir, "grp-runtime-nick.json");
    fs.mkdirSync(path.dirname(groupPath), { recursive: true });
    fs.writeFileSync(groupPath, JSON.stringify({
      group_id: "grp-runtime-nick",
      template_alias: "ui-polish",
      status: "active",
      members: [
        {
          nickname: "designer",
          runtime_nickname: runtimeNick("designer"),
          subscriber_id: "codex:test",
          status: "active",
        },
      ],
    }, null, 2));

    const owner = findOwningGroup(projectRoot, "codex:test");
    expect(owner.group_id).toBe("grp-runtime-nick");
  });

  test("assignSoloRoleToExistingAgent rejects group-owned agents", async () => {
    const groupPath = path.join(getUfooPaths(projectRoot).groupsDir, "grp-1.json");
    fs.mkdirSync(path.dirname(groupPath), { recursive: true });
    fs.writeFileSync(groupPath, JSON.stringify({
      group_id: "grp-1",
      template_alias: "ui-polish",
      status: "active",
      members: [
        {
          nickname: "designer",
          subscriber_id: "codex:test",
          status: "active",
        },
      ],
    }, null, 2));

    const result = await assignSoloRoleToExistingAgent(projectRoot, "designer", "design-critic");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("group-owned");
  });

  test("ignores malformed active group runtime when ownership proof does not match live agent", async () => {
    const groupPath = path.join(getUfooPaths(projectRoot).groupsDir, "grp-stale.json");
    fs.mkdirSync(path.dirname(groupPath), { recursive: true });
    fs.writeFileSync(groupPath, JSON.stringify({
      group_id: "grp-stale",
      template_alias: "ui-polish",
      status: "active",
      members: [
        {
          nickname: "wrong-name",
          subscriber_id: "codex:test",
          status: "active",
        },
      ],
    }, null, 2));

    expect(findOwningGroup(projectRoot, "codex:test")).toBeNull();

    const result = await assignSoloRoleToExistingAgent(projectRoot, "designer", "design-critic", {
      bootstrapOptions: {
        timeoutMs: 20,
        retryDelayMs: 1,
        protectionMs: 1,
        workingGraceMs: 5,
      },
    });
    expect(result.ok).toBe(true);
  });

  test("ignores stale active bus/runtime agreement for ownership proof", async () => {
    fs.writeFileSync(getUfooPaths(projectRoot).agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {
        "codex:test": {
          agent_type: "codex",
          nickname: "designer",
          status: "active",
          activity_state: "ready",
          last_seen: new Date(Date.now() - (31 * 1000)).toISOString(),
          joined_at: new Date(Date.now() - (31 * 1000)).toISOString(),
        },
      },
    }, null, 2));
    const groupPath = path.join(getUfooPaths(projectRoot).groupsDir, "grp-stale-live.json");
    fs.mkdirSync(path.dirname(groupPath), { recursive: true });
    fs.writeFileSync(groupPath, JSON.stringify({
      group_id: "grp-stale-live",
      template_alias: "ui-polish",
      status: "active",
      members: [
        {
          nickname: "designer",
          subscriber_id: "codex:test",
          status: "active",
        },
      ],
    }, null, 2));

    expect(findOwningGroup(projectRoot, "codex:test")).toBeNull();
    const result = await assignSoloRoleToExistingAgent(projectRoot, "designer", "design-critic");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("agent not found");
  });

  test("assignSoloRoleToExistingAgent persists solo role metadata", async () => {
    const result = await assignSoloRoleToExistingAgent(projectRoot, "designer", "design-critic", {
      bootstrapOptions: {
        timeoutMs: 20,
        retryDelayMs: 1,
        protectionMs: 1,
        workingGraceMs: 5,
      },
    });

    expect(result.ok).toBe(true);
    const saved = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));
    expect(saved.agents["codex:test"]).toEqual(expect.objectContaining({
      bootstrap_kind: "solo",
      role_owner: "solo",
      requested_profile: "design-critic",
      resolved_profile: "design-critic",
      bootstrapped_subscriber_id: "codex:test",
    }));
  });

  test("waitForSoloBootstrapReady honors activity_since for long-running working agents", async () => {
    fs.writeFileSync(getUfooPaths(projectRoot).agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      agents: {
        "codex:test": {
          agent_type: "codex",
          nickname: "designer",
          status: "active",
          activity_state: "working",
          activity_since: new Date(Date.now() - 20).toISOString(),
        },
      },
    }, null, 2));

    const result = await waitForSoloBootstrapReady(projectRoot, "codex:test", {
      timeoutMs: 20,
      retryDelayMs: 1,
      protectionMs: 1,
      workingGraceMs: 5,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      activity_state: "working",
      degraded: true,
    }));
  });

  test("rolls back a newly launched agent when post-launch role assignment fails", async () => {
    const handleOps = jest.fn(async (_root, ops) => {
      const op = ops[0];
      if (op.action === "close" && op.agent_id === "codex:new") {
        return [{ action: "close", ok: true, agent_id: "codex:new" }];
      }
      throw new Error(`unexpected op: ${JSON.stringify(op)}`);
    });

    const result = await rollbackLaunchAfterRoleAssignmentFailure(
      projectRoot,
      { action: "launch", ok: true, subscriber_ids: ["codex:new"] },
      "designer",
      handleOps,
      null
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      rolled_back: true,
      target: "codex:new",
    }));
    expect(handleOps).toHaveBeenCalledWith(
      projectRoot,
      [{ action: "close", agent_id: "codex:new" }],
      null
    );
  });
});
