const {
  getSystemPrompt,
  buildPromptContext,
  clearSectionCache,
} = require("../../../src/agents/prompts/native");

function findSection(sections, prefix) {
  return sections.find((s) => typeof s === "string" && s.startsWith(prefix));
}

describe("native system prompt assembly", () => {
  afterEach(() => {
    clearSectionCache();
  });

  test("environment section recomputes with latest provider/model", () => {
    const first = getSystemPrompt({
      workspaceRoot: "/repo",
      provider: "openai",
      model: "gpt-5.1-codex",
    });
    const firstEnv = findSection(first, "# Environment");
    expect(firstEnv).toContain("Provider: openai");
    expect(firstEnv).toContain("Model: gpt-5.1-codex");

    const second = getSystemPrompt({
      workspaceRoot: "/repo",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    const secondEnv = findSection(second, "# Environment");
    expect(secondEnv).toContain("Provider: anthropic");
    expect(secondEnv).toContain("Model: claude-opus-4-6");
    expect(secondEnv).not.toContain("openai");
    expect(secondEnv).not.toContain("gpt-5.1-codex");
  });

  test("static ufoo section stays cached across calls", () => {
    const first = getSystemPrompt({ provider: "openai" });
    const second = getSystemPrompt({ provider: "anthropic" });
    const firstUfoo = findSection(first, "# ufoo integration");
    const secondUfoo = findSection(second, "# ufoo integration");
    expect(firstUfoo).toBeTruthy();
    expect(secondUfoo).toBe(firstUfoo);
  });

  test("buildPromptContext joins sections without boundary marker", () => {
    const context = buildPromptContext({ workspaceRoot: "/repo", provider: "openai" });
    expect(context).toContain("# Environment");
    expect(context).toContain("Provider: openai");
    expect(context).not.toContain("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
  });
});
