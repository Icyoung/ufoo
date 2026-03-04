const { validateTemplate } = require("../../../src/group/validateTemplate");

function buildValidTemplate() {
  return {
    schema_version: 1,
    template: {
      id: "software-dev-basic",
      alias: "dev-basic",
      name: "Software Dev Basic",
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
        id: "builder",
        nickname: "builder",
        type: "claude",
        startup_order: 2,
        depends_on: ["pm"],
        accept_from: ["pm"],
        report_to: ["pm"],
      },
    ],
    edges: [{ from: "pm", to: "builder", kind: "task" }],
  };
}

describe("group validateTemplate", () => {
  test("returns ok for valid template", () => {
    const result = validateTemplate(buildValidTemplate());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects duplicate nickname", () => {
    const sample = buildValidTemplate();
    sample.agents[1].nickname = "pm";
    const result = validateTemplate(sample);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path === "agents[1].nickname")).toBe(true);
  });

  test("rejects unresolved edge reference", () => {
    const sample = buildValidTemplate();
    sample.edges[0].to = "unknown";
    const result = validateTemplate(sample);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path === "edges[0].to")).toBe(true);
  });

  test("rejects cyclic depends_on graph", () => {
    const sample = buildValidTemplate();
    sample.agents.push({
      id: "reviewer",
      nickname: "reviewer",
      type: "ucode",
      startup_order: 3,
      depends_on: ["builder"],
      accept_from: ["builder"],
      report_to: ["pm"],
    });
    sample.agents[1].depends_on = ["reviewer"];

    const result = validateTemplate(sample);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path === "agents[*].depends_on")).toBe(true);
  });

  test("rejects invalid agent type and startup_order", () => {
    const sample = buildValidTemplate();
    sample.agents[1].type = "gpt";
    sample.agents[1].startup_order = -1;
    const result = validateTemplate(sample);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path === "agents[1].type")).toBe(true);
    expect(result.errors.some((item) => item.path === "agents[1].startup_order")).toBe(true);
  });

  test("rejects unresolved depends_on/accept_from/report_to refs", () => {
    const sample = buildValidTemplate();
    sample.agents[1].depends_on = ["missing-a"];
    sample.agents[1].accept_from = ["missing-b"];
    sample.agents[1].report_to = ["missing-c"];
    const result = validateTemplate(sample);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path === "agents[1].depends_on[0]")).toBe(true);
    expect(result.errors.some((item) => item.path === "agents[1].accept_from[0]")).toBe(true);
    expect(result.errors.some((item) => item.path === "agents[1].report_to[0]")).toBe(true);
  });

  test("rejects self dependency and non-array refs", () => {
    const sample = buildValidTemplate();
    sample.agents[0].depends_on = ["pm"];
    sample.agents[1].accept_from = "pm";
    const result = validateTemplate(sample);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path === "agents[0].depends_on[0]")).toBe(true);
    expect(result.errors.some((item) => item.path === "agents[1].accept_from")).toBe(true);
  });
});
