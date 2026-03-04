const {
  normalizeFormat,
  renderGroupDiagramFromTemplate,
  renderGroupDiagramFromRuntime,
} = require("../../../src/group/diagram");

describe("group diagram renderer", () => {
  test("normalizeFormat supports ascii and mermaid", () => {
    expect(normalizeFormat("ascii")).toBe("ascii");
    expect(normalizeFormat("mermaid")).toBe("mermaid");
    expect(normalizeFormat("unknown")).toBe("ascii");
  });

  test("renderGroupDiagramFromTemplate returns ASCII summary", () => {
    const text = renderGroupDiagramFromTemplate({
      template: { alias: "dev-basic" },
      agents: [
        { id: "pm", nickname: "pm", type: "claude", startup_order: 1, depends_on: [] },
        { id: "dev", nickname: "dev", type: "codex", startup_order: 2, depends_on: ["pm"] },
      ],
      edges: [{ from: "pm", to: "dev", kind: "task" }],
    });

    expect(text).toContain("Group Diagram (template: dev-basic)");
    expect(text).toContain("Members (2):");
    expect(text).toContain("- pm [claude] order=1 deps=-");
    expect(text).toContain("- dev [codex] order=2 deps=pm");
    expect(text).toContain("- pm -> dev (task)");
  });

  test("renderGroupDiagramFromTemplate supports mermaid", () => {
    const text = renderGroupDiagramFromTemplate(
      {
        template: { alias: "research-quick" },
        agents: [{ id: "researcher", nickname: "researcher", type: "claude" }],
        edges: [],
      },
      { format: "mermaid" }
    );

    expect(text).toContain("flowchart LR");
    expect(text).toContain("researcher");
  });

  test("renderGroupDiagramFromRuntime returns status-aware ASCII summary", () => {
    const text = renderGroupDiagramFromRuntime({
      group_id: "dev-basic-a1b2",
      status: "active",
      members: [
        {
          template_agent_id: "pm",
          nickname: "pm",
          type: "claude",
          startup_order: 1,
          depends_on: [],
          status: "active",
          subscriber_id: "claude-code:pm01",
        },
      ],
    });

    expect(text).toContain("Group Diagram (runtime: dev-basic-a1b2)");
    expect(text).toContain("Status: active");
    expect(text).toContain("- pm [claude] order=1 deps=- status=active sub=claude-code:pm01");
  });
});
