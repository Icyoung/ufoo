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

  test("environment section shows bus identity from env and hides it when absent", () => {
    const savedId = process.env.UFOO_SUBSCRIBER_ID;
    const savedNick = process.env.UFOO_NICKNAME;
    try {
      process.env.UFOO_SUBSCRIBER_ID = "ucode:abc123";
      process.env.UFOO_NICKNAME = "ucode-3";
      const withIdentity = getSystemPrompt({ workspaceRoot: "/repo" });
      expect(findSection(withIdentity, "# Environment"))
        .toContain("Bus identity: ucode:abc123 (nickname: ucode-3)");

      delete process.env.UFOO_SUBSCRIBER_ID;
      delete process.env.UFOO_NICKNAME;
      const withoutIdentity = getSystemPrompt({ workspaceRoot: "/repo" });
      expect(findSection(withoutIdentity, "# Environment")).not.toContain("Bus identity:");
    } finally {
      if (savedId === undefined) delete process.env.UFOO_SUBSCRIBER_ID;
      else process.env.UFOO_SUBSCRIBER_ID = savedId;
      if (savedNick === undefined) delete process.env.UFOO_NICKNAME;
      else process.env.UFOO_NICKNAME = savedNick;
    }
  });

  test("ufoo section frames shared records as other agents' work", () => {
    const sections = getSystemPrompt({ workspaceRoot: "/repo" });
    const ufoo = findSection(sections, "# ufoo integration");
    expect(ufoo).toContain("OTHER agents");
    expect(ufoo).toContain("not your work history");
  });
});
