const {
  shouldUseUcodeTui,
  buildUcodeBannerLines,
  parseActiveAgentsFromBusStatus,
  renderLogLinesWithMarkdown,
  shouldEnterAgentSelection,
  resolveAgentSelectionOnDown,
  cycleAgentSelectionIndex,
  shouldClearAgentSelectionOnUp,
  moveCursorHorizontally,
  clampCursorPos,
  findLogicalLineStart,
  findLogicalLineEnd,
  moveCursorToVisualLineBoundary,
  moveCursorVertically,
  deleteWordBeforeCursor,
  moveCursorByWord,
  resolveHistoryDownTransition,
  filterSelectableAgents,
  stripLeakedEscapeTags,
  createEscapeTagStripper,
  formatPendingElapsed,
  normalizeBashToolCommand,
  normalizeToolMergeEntry,
  buildMergedToolSummaryText,
  buildMergedToolExpandedLines,
  UCODE_BANNER_LINES,
  UCODE_VERSION,
} = require("../../../src/code/tui");

describe("ucode tui switch", () => {
  test("uses tui by default for tty interactive mode", () => {
    const useTui = shouldUseUcodeTui({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      jsonOutput: false,
    });
    expect(useTui).toBe(true);
  });

  test("disables tui for json output", () => {
    const useTui = shouldUseUcodeTui({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      jsonOutput: true,
    });
    expect(useTui).toBe(false);
  });

  test("forceTui overrides non-tty", () => {
    const useTui = shouldUseUcodeTui({
      stdin: { isTTY: false },
      stdout: { isTTY: false },
      jsonOutput: false,
      forceTui: true,
    });
    expect(useTui).toBe(true);
  });

  test("disableTui wins over forceTui", () => {
    const useTui = shouldUseUcodeTui({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      jsonOutput: false,
      forceTui: true,
      disableTui: true,
    });
    expect(useTui).toBe(false);
  });

  test("banner includes version, model, and dictionary", () => {
    const lines = buildUcodeBannerLines({
      model: "gpt-5.2-codex",
      engine: "ufoo-core",
      width: 120,
    });
    expect(lines[0]).toContain("Version:");
    expect(lines[0]).toContain(UCODE_VERSION);
    expect(lines[1]).toContain("Model:");
    expect(lines[1]).toContain("gpt-5.2-codex");
    expect(lines[2]).toContain("Dictionary:");
    expect(lines[0]).toContain("█ █ █▀▀");
  });

  test("banner places session under dictionary with aligned metadata column", () => {
    const lines = buildUcodeBannerLines({
      model: "gpt-5.2-codex",
      workspaceRoot: "/tmp/repo",
      sessionId: "sess-abc123",
    });
    const stripAnsi = (value) => String(value || "").replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
    const plainLines = lines.map((line) => stripAnsi(line));
    const dictionaryLine = plainLines.find((line) => line.includes("Dictionary:"));
    const sessionLine = plainLines.find((line) => line.includes("Session:"));

    expect(dictionaryLine).toBeTruthy();
    expect(sessionLine).toBeTruthy();
    expect(plainLines.indexOf(sessionLine)).toBe(plainLines.indexOf(dictionaryLine) + 1);
    expect(sessionLine.indexOf("Session:")).toBe(dictionaryLine.indexOf("Dictionary:"));
  });

  test("banner keeps metadata area to version/model/dictionary only", () => {
    const lines = buildUcodeBannerLines({
      model: "gpt-5.2-codex",
      nickname: "icy",
      agentId: "",
      width: 120,
    });
    const all = lines.join("\n");
    expect(all).toContain("Version:");
    expect(all).toContain("Model:");
    expect(all).toContain("Dictionary:");
    expect(all).not.toContain("Nickname:");
    expect(all).not.toContain("Agent:");
    expect(all).not.toContain("Daemon:");
  });

  test("banner uses a single ucode logo block when nickname exists", () => {
    const lines = buildUcodeBannerLines({
      model: "gpt-5.2-codex",
      nickname: "icy",
      agentId: "4fc7103b",
      width: 120,
    });
    const logoHeadCount = lines.filter((line) => line.includes(UCODE_BANNER_LINES[0])).length;
    expect(logoHeadCount).toBe(1);
  });

  test("parses current bus status online agents list", () => {
    const raw = [
      "\u001b[0;36m=== Event Bus Status ===\u001b[0m",
      "",
      "Bus ID: ufoo",
      "",
      "\u001b[0;36mOnline agents:\u001b[0m",
      "  codex:3cf3c96d (codex-1)",
      "  ufoo-agent (ufoo-agent)",
      "",
      "\u001b[0;36mEvent statistics:\u001b[0m",
    ].join("\n");
    const agents = parseActiveAgentsFromBusStatus(raw);
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "codex",
          id: "3cf3c96d",
          fullId: "codex:3cf3c96d",
          nickname: "codex-1",
        }),
        expect.objectContaining({
          type: "ufoo-agent",
          id: "",
          fullId: "ufoo-agent",
          nickname: "ufoo-agent",
        }),
      ])
    );
  });

  test("renders fenced code blocks with dedicated log styling", () => {
    const state = { inCodeBlock: false };
    const lines = renderLogLinesWithMarkdown(
      "before\n```bash\nls\n```\nafter",
      state,
      (v) => `<${v}>`
    );

    expect(lines).toEqual([
      "<before>",
      "{gray-fg}┌ code:<bash>{/gray-fg}",
      "{gray-fg}│{/gray-fg} {white-fg}<ls>{/white-fg}",
      "{gray-fg}└{/gray-fg}",
      "<after>",
    ]);
    expect(state.inCodeBlock).toBe(false);
  });

  test("consumes backtick/tilde fence lines even when prefixed by leaked escape tag", () => {
    const state = { inCodeBlock: false };
    const lines = renderLogLinesWithMarkdown(
      "{/escape}```ts\nx\n```\n~~~js\ny\n~~~",
      state,
      (v) => `<${v}>`
    );

    expect(lines).toEqual([
      "{gray-fg}┌ code:<ts>{/gray-fg}",
      "{gray-fg}│{/gray-fg} {white-fg}<x>{/white-fg}",
      "{gray-fg}└{/gray-fg}",
      "{gray-fg}┌ code:<js>{/gray-fg}",
      "{gray-fg}│{/gray-fg} {white-fg}<y>{/white-fg}",
      "{gray-fg}└{/gray-fg}",
    ]);
    expect(state.inCodeBlock).toBe(false);
  });

  test("keeps markdown render state across multiple log chunks", () => {
    const state = { inCodeBlock: false };
    const first = renderLogLinesWithMarkdown(
      "```js\nconst x = 1;",
      state,
      (v) => `<${v}>`
    );
    expect(first).toEqual([
      "{gray-fg}┌ code:<js>{/gray-fg}",
      "{gray-fg}│{/gray-fg} {white-fg}<const x = 1;>{/white-fg}",
    ]);
    expect(state.inCodeBlock).toBe(true);

    const second = renderLogLinesWithMarkdown(
      "console.log(x)\n```",
      state,
      (v) => `<${v}>`
    );
    expect(second).toEqual([
      "{gray-fg}│{/gray-fg} {white-fg}<console.log(x)>{/white-fg}",
      "{gray-fg}└{/gray-fg}",
    ]);
    expect(state.inCodeBlock).toBe(false);
  });

  test("renders markdown headings, lists, blockquotes and inline code", () => {
    const state = { inCodeBlock: false };
    const lines = renderLogLinesWithMarkdown(
      "# Title\n- item `x`\n1. step\n> quote",
      state,
      (v) => String(v)
    );

    expect(lines).toEqual([
      "{cyan-fg}#{/cyan-fg} {bold}Title{/bold}",
      "{gray-fg}•{/gray-fg} item {yellow-fg}x{/yellow-fg}",
      "{gray-fg}1.{/gray-fg} step",
      "{gray-fg}▍{/gray-fg} quote",
    ]);
  });

  test("renders inline code in normal lines", () => {
    const state = { inCodeBlock: false };
    const lines = renderLogLinesWithMarkdown(
      "plain `snippet` text",
      state,
      (v) => String(v)
    );

    expect(lines).toEqual([
      "plain {yellow-fg}snippet{/yellow-fg} text",
    ]);
  });

  test("does not call escape function for empty lines", () => {
    const state = { inCodeBlock: false };
    const escapeFn = jest.fn((v) => `<${v}>`);
    const lines = renderLogLinesWithMarkdown("\nhello\n", state, escapeFn);
    expect(lines).toEqual(["", "<hello>", ""]);
    expect(escapeFn).toHaveBeenCalledTimes(1);
  });

  test("renders Error lines in red for visibility", () => {
    const state = { inCodeBlock: false };
    const lines = renderLogLinesWithMarkdown(
      "Error: fetch failed",
      state,
      (v) => String(v)
    );
    expect(lines).toEqual([
      "{red-fg}Error: fetch failed{/red-fg}",
    ]);
  });

  test("shouldEnterAgentSelection only when input is empty", () => {
    expect(shouldEnterAgentSelection("")).toBe(true);
    expect(shouldEnterAgentSelection("   ")).toBe(true);
    expect(shouldEnterAgentSelection("@codex-1")).toBe(false);
    expect(shouldEnterAgentSelection("hello")).toBe(false);
  });

  test("resolveAgentSelectionOnDown enters once then holds", () => {
    expect(resolveAgentSelectionOnDown({
      agentSelectionMode: false,
      selectedAgentIndex: -1,
      totalAgents: 3,
    })).toEqual({ action: "enter", index: 0 });

    expect(resolveAgentSelectionOnDown({
      agentSelectionMode: true,
      selectedAgentIndex: 1,
      totalAgents: 3,
    })).toEqual({ action: "hold", index: 1 });
  });

  test("cycleAgentSelectionIndex rotates by left/right", () => {
    expect(cycleAgentSelectionIndex(0, 3, "left")).toBe(2);
    expect(cycleAgentSelectionIndex(2, 3, "right")).toBe(0);
    expect(cycleAgentSelectionIndex(-1, 3, "right")).toBe(1);
  });

  test("shouldClearAgentSelectionOnUp clears only in selection mode with empty input", () => {
    expect(shouldClearAgentSelectionOnUp({
      agentSelectionMode: true,
      inputValue: "",
    })).toBe(true);
    expect(shouldClearAgentSelectionOnUp({
      agentSelectionMode: true,
      inputValue: "typing",
    })).toBe(false);
    expect(shouldClearAgentSelectionOnUp({
      agentSelectionMode: false,
      inputValue: "",
    })).toBe(false);
  });

  test("moveCursorHorizontally clamps within input bounds", () => {
    expect(moveCursorHorizontally(0, "hello", "left")).toBe(0);
    expect(moveCursorHorizontally(0, "hello", "right")).toBe(1);
    expect(moveCursorHorizontally(4, "hello", "right")).toBe(5);
    expect(moveCursorHorizontally(5, "hello", "right")).toBe(5);
    expect(moveCursorHorizontally(3, "hello", "left")).toBe(2);
  });

  test("input cursor helpers clamp and find logical line bounds", () => {
    expect(clampCursorPos(20, "hello")).toBe(5);
    expect(clampCursorPos(-2, "hello")).toBe(0);
    expect(findLogicalLineStart("aa\nbbb\nc", 5)).toBe(3);
    expect(findLogicalLineEnd("aa\nbbb\nc", 5)).toBe(6);
  });

  test("input cursor helpers move across wrapped visual lines", () => {
    const text = "abcdef";
    expect(moveCursorToVisualLineBoundary({
      cursorPos: 4,
      inputValue: text,
      width: 3,
      boundary: "start",
    })).toBe(3);
    expect(moveCursorToVisualLineBoundary({
      cursorPos: 4,
      inputValue: text,
      width: 3,
      boundary: "end",
    })).toBe(6);
    expect(moveCursorVertically({
      cursorPos: 4,
      inputValue: text,
      width: 3,
      direction: "up",
    })).toMatchObject({ moved: true, nextCursorPos: 1 });
    expect(moveCursorVertically({
      cursorPos: 1,
      inputValue: text,
      width: 3,
      direction: "up",
    })).toMatchObject({ moved: false, boundary: "top" });
  });

  test("input word helpers match shell-style editing", () => {
    expect(deleteWordBeforeCursor("alpha beta  ", 12)).toEqual({
      value: "alpha",
      cursorPos: 5,
    });
    expect(moveCursorByWord("alpha beta", 10, "backward")).toBe(6);
    expect(moveCursorByWord("alpha beta", 0, "forward")).toBe(5);
  });

  test("resolveHistoryDownTransition moves through history then stops at latest", () => {
    expect(resolveHistoryDownTransition({
      inputHistory: ["a", "b", "c"],
      historyIndex: 1,
      currentValue: "b",
    })).toEqual({
      moved: true,
      nextHistoryIndex: 2,
      nextValue: "c",
    });

    expect(resolveHistoryDownTransition({
      inputHistory: ["a", "b", "c"],
      historyIndex: 2,
      currentValue: "c",
    })).toEqual({
      moved: true,
      nextHistoryIndex: 3,
      nextValue: "",
    });

    expect(resolveHistoryDownTransition({
      inputHistory: ["a", "b", "c"],
      historyIndex: 3,
      currentValue: "",
    })).toEqual({
      moved: false,
      nextHistoryIndex: 3,
      nextValue: "",
    });
  });

  test("filterSelectableAgents excludes current subscriber", () => {
    const all = [
      { fullId: "ufoo-code:abc123", nickname: "self" },
      { fullId: "ufoo-agent", type: "ufoo-agent", nickname: "ufoo-agent" },
      { fullId: "codex:111111", nickname: "codex-1" },
      { fullId: "claude-code:222222", nickname: "claude-1" },
    ];
    const filtered = filterSelectableAgents(all, "ufoo-code:abc123");
    expect(filtered).toEqual([
      { fullId: "codex:111111", nickname: "codex-1" },
      { fullId: "claude-code:222222", nickname: "claude-1" },
    ]);
  });

  test("stripLeakedEscapeTags removes leaked blessed escape markers", () => {
    const input = "line1\n{/escape}\nline2 {escape}x{/escape}";
    expect(stripLeakedEscapeTags(input)).toBe("line1\n\nline2 x");
  });

  test("stripLeakedEscapeTags removes case/space variants", () => {
    const input = "a {/ Escape } b { ESCAPE } c";
    expect(stripLeakedEscapeTags(input)).toBe("a  b  c");
  });

  test("stripLeakedEscapeTags removes loose escape variants inside braces", () => {
    const input = "x { /escape } y {escape!!!} z {foo escape bar}";
    expect(stripLeakedEscapeTags(input)).toBe("x  y  z ");
  });

  test("stripLeakedEscapeTags removes dangling escape prefixes without closing brace", () => {
    const input = "head {/escape tail { /esc";
    expect(stripLeakedEscapeTags(input)).toBe("head ");
  });

  test("createEscapeTagStripper removes split escape tags across chunks", () => {
    const stripper = createEscapeTagStripper();
    expect(stripper.write("{esc")).toBe("");
    expect(stripper.write("ape}abc{/esc")).toBe("abc");
    expect(stripper.write("ape}def")).toBe("def");
    expect(stripper.flush()).toBe("");
  });

  test("createEscapeTagStripper keeps normal text while flushing trailing partial tag", () => {
    const stripper = createEscapeTagStripper();
    expect(stripper.write("hello {")).toBe("hello ");
    expect(stripper.write("/escape")).toBe("");
    expect(stripper.flush()).toBe("");
  });

  test("createEscapeTagStripper removes split escape tags with spaces", () => {
    const stripper = createEscapeTagStripper();
    expect(stripper.write("{ /es")).toBe("");
    expect(stripper.write("cape }ok")).toBe("ok");
    expect(stripper.flush()).toBe("");
  });

  test("formatPendingElapsed renders seconds suffix", () => {
    expect(formatPendingElapsed(0)).toBe("0 s");
    expect(formatPendingElapsed(65000)).toBe("65 s");
    expect(formatPendingElapsed(3661000)).toBe("3661 s");
  });

  test("normalizeBashToolCommand includes command and exit code", () => {
    expect(normalizeBashToolCommand(
      { command: "ls -la" },
      { code: 0 }
    )).toBe("ls -la · exit 0");
    expect(normalizeBashToolCommand(
      { cmd: "pwd" },
      {}
    )).toBe("pwd");
  });

  test("normalizeToolMergeEntry normalizes fields for fold rendering", () => {
    expect(normalizeToolMergeEntry({
      tool: "READ",
      detail: "AGENTS.md",
      isError: true,
      errorText: "not found",
    })).toEqual({
      tool: "read",
      detail: "AGENTS.md",
      isError: true,
      errorText: "not found",
      summary: "read · AGENTS.md",
    });
  });

  test("buildMergedToolSummaryText summarizes consecutive tool calls", () => {
    expect(buildMergedToolSummaryText([])).toBe("Ran tool");
    expect(buildMergedToolSummaryText([{ tool: "bash", detail: "ls -la" }])).toBe("Ran bash · ls -la");
    expect(buildMergedToolSummaryText([
      { tool: "read", detail: "AGENTS.md" },
      { tool: "bash", detail: "ls -la" },
    ])).toBe(
      "Ran read · AGENTS.md · … +1 calls"
    );
  });

  test("buildMergedToolExpandedLines returns expanded rows", () => {
    expect(buildMergedToolExpandedLines([
      { tool: "read", detail: "AGENTS.md" },
      { tool: "bash", detail: "ls -la", isError: true, errorText: "exit 1" },
    ])).toEqual([
      "read · AGENTS.md",
      "bash · ls -la · error: exit 1",
    ]);
  });
});
