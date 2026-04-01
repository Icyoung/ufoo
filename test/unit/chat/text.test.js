const {
  neutralizeBlessedCommaTags,
  escapeBlessed,
  decodeEscapedNewlines,
  stripBlessedTags,
  stripAnsi,
  truncateAnsi,
  truncateText,
} = require("../../../src/chat/text");

describe("chat text helpers", () => {
  test("neutralizeBlessedCommaTags avoids comma/semicolon blessed tags", () => {
    expect(neutralizeBlessedCommaTags("{red,bold}x{/red,bold}")).toBe("{red, bold}x{/red, bold}");
    expect(neutralizeBlessedCommaTags("{green;underline}x{/green;underline}")).toBe("{green; underline}x{/green; underline}");
  });

  test("escapeBlessed escapes null and protects closing escape tag", () => {
    expect(escapeBlessed(null)).toBe("");
    expect(escapeBlessed("")).toBe("");
    expect(escapeBlessed("a{/escape}b")).toBe("{escape}a{open}/escape{close}b{/escape}");
  });

  test("decodeEscapedNewlines converts literal newline escapes", () => {
    expect(decodeEscapedNewlines("hello\\nworld")).toBe("hello\nworld");
    expect(decodeEscapedNewlines(null)).toBe("");
  });

  test("stripBlessedTags removes blessed style tags", () => {
    expect(stripBlessedTags("{red-fg}hello{/red-fg}")).toBe("hello");
  });

  test("stripAnsi removes ansi color escapes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  test("truncateAnsi limits visible length and closes style", () => {
    const input = "\u001b[32mabcdef\u001b[0m";
    const out = truncateAnsi(input, 3);
    expect(stripAnsi(out)).toBe("abc");
    expect(out.endsWith("\u001b[0m")).toBe(true);
  });

  test("truncateText truncates with ellipsis", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hello world", 5)).toBe("he...");
    expect(truncateText("hello world", 3)).toBe("hel");
  });
});
