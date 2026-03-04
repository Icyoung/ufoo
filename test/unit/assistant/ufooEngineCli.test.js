const {
  normalizeProvider,
  parseAssistantTaskArgs,
  buildPrompt,
  parseStdinPayload,
  runUfooEngineCli,
} = require("../../../src/assistant/ufooEngineCli");

describe("ufoo engine cli", () => {
  test("parses assistant-task cli args", () => {
    const parsed = parseAssistantTaskArgs([
      "--assistant-task",
      "--json",
      "--model",
      "m1",
      "--session-id",
      "sess-1",
      "--kind",
      "explore",
      "--context",
      "ctx",
      "--expect",
      "exp",
      "--timeout-ms",
      "91000",
      "scan",
      "repo",
    ]);
    expect(parsed).toEqual(expect.objectContaining({
      assistantTask: true,
      json: true,
      model: "m1",
      sessionId: "sess-1",
      kind: "explore",
      context: "ctx",
      expect: "exp",
      timeoutMs: 91000,
      task: "scan repo",
    }));
  });

  test("normalizeProvider accepts codex/claude aliases", () => {
    expect(normalizeProvider("codex")).toBe("codex-cli");
    expect(normalizeProvider("claude")).toBe("claude-cli");
    expect(normalizeProvider("")).toBe("codex-cli");
  });

  test("buildPrompt includes task sections", () => {
    const prompt = buildPrompt({
      kind: "bash",
      context: "repo",
      task: "ls",
      expect: "files",
    });
    expect(prompt).toContain("Task kind: bash");
    expect(prompt).toContain("Context:");
    expect(prompt).toContain("Task:");
    expect(prompt).toContain("Expected result:");
  });

  test("parseStdinPayload parses first json line", () => {
    const payload = parseStdinPayload("\n{\"task\":\"scan\"}\nnoise\n");
    expect(payload).toEqual({ task: "scan" });
  });

  test("runs assistant-task flow with mocked backend", async () => {
    const runCliAgentImpl = jest.fn().mockResolvedValue({
      ok: true,
      sessionId: "sess-a",
      output: "{\"ok\":true,\"summary\":\"done\"}",
    });
    const normalizeCliOutputImpl = jest.fn((value) => String(value));
    const loadConfigImpl = jest.fn(() => ({ agentProvider: "codex-cli", agentModel: "" }));

    const res = await runUfooEngineCli({
      argv: ["--assistant-task", "--json", "--provider", "claude", "scan repo"],
      deps: {
        runCliAgentImpl,
        normalizeCliOutputImpl,
        loadConfigImpl,
        cwd: "/tmp/proj",
        env: {},
      },
    });

    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.output.trim());
    expect(out.ok).toBe(true);
    expect(out.summary).toBe("done");
    expect(out.session_id).toBe("sess-a");
    expect(runCliAgentImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        prompt: expect.stringContaining("Task:\nscan repo"),
      })
    );
  });

  test("runs stdin-json fallback flow", async () => {
    const runCliAgentImpl = jest.fn().mockResolvedValue({
      ok: true,
      sessionId: "sess-b",
      output: "plain",
    });
    const res = await runUfooEngineCli({
      stdinText: "{\"task\":\"scan\",\"kind\":\"explore\"}\n",
      deps: {
        runCliAgentImpl,
        normalizeCliOutputImpl: (value) => String(value),
        loadConfigImpl: () => ({ agentProvider: "codex-cli", agentModel: "" }),
        cwd: "/tmp/proj",
        env: {},
      },
    });
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.output.trim());
    expect(out.summary).toBe("plain");
    expect(out.session_id).toBe("sess-b");
  });
});
