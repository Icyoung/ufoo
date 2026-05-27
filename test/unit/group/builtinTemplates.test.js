const path = require("path");
const { loadTemplateRegistry } = require("../../../src/orchestration/groups/templates");
const { validateTemplateEntry } = require("../../../src/orchestration/groups/templateValidation");

describe("builtin group templates", () => {
  test("repo builtin templates validate with the prompt profile registry", () => {
    const projectRoot = path.join(__dirname, "..", "..", "..");
    const registry = loadTemplateRegistry(projectRoot, {
      builtinDir: path.join(projectRoot, "templates", "groups"),
      globalDir: path.join(projectRoot, ".tmp-no-global-templates"),
      projectDir: path.join(projectRoot, ".tmp-no-project-templates"),
    });
    const aliases = registry.templates.map((item) => item.alias);

    expect(aliases).toEqual(
      expect.arrayContaining([
        "product-discovery",
        "build-lane",
        "build-ultra",
        "verify-ship",
        "ui-polish",
        "design-system",
        "ui-plan-review",
      ])
    );

    for (const entry of registry.templates) {
      const result = validateTemplateEntry(projectRoot, entry, {
        promptProfilesOptions: {
          globalDir: path.join(projectRoot, ".tmp-no-global-profiles"),
          projectDir: path.join(projectRoot, ".tmp-no-project-profiles"),
        },
      });
      expect(result.ok).toBe(true);
    }
  });

  test("builtin template handoff paths are bidirectional for soft policy", () => {
    const projectRoot = path.join(__dirname, "..", "..", "..");
    const registry = loadTemplateRegistry(projectRoot, {
      builtinDir: path.join(projectRoot, "templates", "groups"),
      globalDir: path.join(projectRoot, ".tmp-no-global-templates"),
      projectDir: path.join(projectRoot, ".tmp-no-project-templates"),
    });

    function expectCanReply(entry, from, to, sourcePath) {
      const agents = new Map(entry.data.agents.map((agent) => [agent.nickname, agent]));
      const fromAgent = agents.get(from);
      const toAgent = agents.get(to);
      if (!fromAgent) throw new Error(`${entry.alias} missing source ${from} for ${sourcePath}`);
      if (!toAgent) throw new Error(`${entry.alias} missing target ${to} for ${sourcePath}`);
      if (!(toAgent.accept_from || []).includes(from)) {
        throw new Error(`${entry.alias} ${to}.accept_from should include ${from}`);
      }
      if (!(fromAgent.accept_from || []).includes(to)) {
        throw new Error(`${entry.alias} ${from}.accept_from should include ${to} for reply`);
      }
    }

    for (const entry of registry.templates) {
      const edges = Array.isArray(entry.data.edges) ? entry.data.edges : [];
      for (const edge of edges) {
        expectCanReply(entry, edge.from, edge.to, `edge ${edge.from}->${edge.to}`);
      }

      for (const agent of entry.data.agents) {
        const targets = Array.isArray(agent.report_to) ? agent.report_to : [];
        for (const target of targets) {
          expectCanReply(entry, agent.nickname, target, `report_to ${agent.nickname}->${target}`);
        }
      }
    }
  });

  test("builtin templates expose operator-facing descriptions", () => {
    const projectRoot = path.join(__dirname, "..", "..", "..");
    const registry = loadTemplateRegistry(projectRoot, {
      builtinDir: path.join(projectRoot, "templates", "groups"),
      globalDir: path.join(projectRoot, ".tmp-no-global-templates"),
      projectDir: path.join(projectRoot, ".tmp-no-project-templates"),
    });

    const byAlias = new Map(registry.templates.map((item) => [item.alias, item]));
    for (const alias of [
      "build-lane",
      "build-ultra",
      "product-discovery",
      "verify-ship",
      "ui-polish",
      "design-system",
      "ui-plan-review",
    ]) {
      expect(byAlias.get(alias)?.templateDescription).toEqual(expect.any(String));
      expect(byAlias.get(alias).templateDescription.length).toBeGreaterThan(20);
    }

    expect(byAlias.get("product-discovery").templateDescription).toContain("does not implement");
    expect(byAlias.get("design-system").templateDescription).toContain("does not edit UI code");
    expect(byAlias.get("verify-ship").templateDescription).toContain("Post-change");
  });

  test("build-lane is a complete default engineering lane", () => {
    const projectRoot = path.join(__dirname, "..", "..", "..");
    const registry = loadTemplateRegistry(projectRoot, {
      builtinDir: path.join(projectRoot, "templates", "groups"),
      globalDir: path.join(projectRoot, ".tmp-no-global-templates"),
      projectDir: path.join(projectRoot, ".tmp-no-project-templates"),
    });

    const buildLane = registry.byAlias.get("build-lane");
    const agents = new Map(buildLane.data.agents.map((agent) => [agent.nickname, agent]));

    expect(agents.has("qa")).toBe(false);
    expect(agents.get("architect")).toEqual(
      expect.objectContaining({
        prompt_profile: "system-architect",
        startup_order: 1,
      })
    );
    expect(agents.get("architect").role).toContain("PMO");
    expect(agents.get("architect").role).toContain("multi-agent");
    expect(agents.get("architect").role).toContain("phased");
    expect(agents.get("architect").role).toContain("test handoff");
    expect(agents.get("reviewer")).toEqual(
      expect.objectContaining({
        prompt_profile: "review-critic",
        startup_order: 3,
      })
    );
    expect(agents.get("reviewer").role).toContain("QA");
    expect(agents.get("reviewer").report_to).toEqual(expect.arrayContaining(["builder", "architect"]));
    expect(buildLane.data.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "builder", to: "reviewer" }),
        expect.objectContaining({ from: "reviewer", to: "builder" }),
        expect.objectContaining({ from: "reviewer", to: "architect" }),
      ])
    );
    expect(buildLane.data.edges.some((edge) => edge.from === "qa" || edge.to === "qa")).toBe(false);
  });
});
