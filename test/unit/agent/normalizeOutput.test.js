const { normalizeCliOutput } = require("../../../src/agent/normalizeOutput");

describe("agent normalizeOutput", () => {
  test("preserves reply field for claude-style object output", () => {
    expect(normalizeCliOutput({ reply: "done", dispatch: [], ops: [] })).toBe("done");
  });

  test("returns empty string for falsy input", () => {
    expect(normalizeCliOutput(null)).toBe("");
    expect(normalizeCliOutput(undefined)).toBe("");
    expect(normalizeCliOutput("")).toBe("");
  });

  test("returns string input as-is", () => {
    expect(normalizeCliOutput("hello world")).toBe("hello world");
  });

  test("joins string array elements", () => {
    expect(normalizeCliOutput(["hello", "world"])).toBe("hello\nworld");
  });

  test("extracts text from array of objects with text field", () => {
    expect(normalizeCliOutput([{ text: "line1" }, { text: "line2" }])).toBe("line1\nline2");
  });

  test("extracts content from array of objects with content field", () => {
    expect(normalizeCliOutput([{ content: "c1" }])).toBe("c1");
  });

  test("extracts output from array of objects with output field", () => {
    expect(normalizeCliOutput([{ output: "o1" }])).toBe("o1");
  });

  test("handles agent_message items", () => {
    const input = [
      { item: { type: "agent_message", text: "agent says hello" } },
    ];
    expect(normalizeCliOutput(input)).toBe("agent says hello");
  });

  test("handles mixed array types", () => {
    const input = ["plain text", { text: "object text" }];
    expect(normalizeCliOutput(input)).toBe("plain text\nobject text");
  });

  test("extracts output_text from object", () => {
    expect(normalizeCliOutput({ output_text: "result" })).toBe("result");
  });

  test("extracts text from object", () => {
    expect(normalizeCliOutput({ text: "hello" })).toBe("hello");
  });

  test("extracts message from object", () => {
    expect(normalizeCliOutput({ message: "msg" })).toBe("msg");
  });

  test("extracts content from object", () => {
    expect(normalizeCliOutput({ content: "cnt" })).toBe("cnt");
  });

  test("extracts result from object", () => {
    expect(normalizeCliOutput({ result: "res" })).toBe("res");
  });

  test("handles structured_output", () => {
    const input = { structured_output: { key: "value" } };
    const result = normalizeCliOutput(input);
    expect(result).toContain("key");
    expect(result).toContain("value");
  });

  test("returns empty string for object with no recognized fields", () => {
    expect(normalizeCliOutput({ unknown: 123 })).toBe("");
  });

  test("handles empty array", () => {
    expect(normalizeCliOutput([])).toBe("");
  });
});
