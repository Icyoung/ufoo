"use strict";

const { computeStatusText } = require("../../../src/ui/components/UcodeApp");
const fmt = require("../../../src/ui/format");

describe("computeStatusText", () => {
  test("idle returns 'UCODE · Ready'", () => {
    expect(computeStatusText({ message: "" }, 0)).toBe("UCODE · Ready");
    expect(computeStatusText({}, 0)).toBe("UCODE · Ready");
  });

  test("non-empty message uses the spinner indicator and message", () => {
    const text = computeStatusText({ message: "Thinking...", type: "thinking" }, 0);
    expect(text.startsWith(fmt.STATUS_INDICATORS.thinking[0])).toBe(true);
    expect(text).toMatch(/Thinking\.\.\./);
  });

  test("spinner cycles with the tick", () => {
    const a = computeStatusText({ message: "x", type: "thinking" }, 0);
    const b = computeStatusText({ message: "x", type: "thinking" }, 1);
    expect(a).not.toEqual(b);
  });

  test("typing type uses its own spinner family", () => {
    const text = computeStatusText({ message: "Sending...", type: "typing" }, 0);
    expect(text.startsWith(fmt.STATUS_INDICATORS.typing[0])).toBe(true);
  });

  test("showTimer appends elapsed seconds and the cancel hint", () => {
    const startedAt = Date.now() - 3500;
    const text = computeStatusText({
      message: "Generating response...",
      type: "thinking",
      showTimer: true,
      startedAt,
    }, 0);
    expect(text).toMatch(/\(\d+ s, esc cancel\)$/);
  });

  test("unknown type falls back to thinking", () => {
    const text = computeStatusText({ message: "x", type: "nonsense" }, 0);
    expect(text.startsWith(fmt.STATUS_INDICATORS.thinking[0])).toBe(true);
  });

  test("background suffix is appended while idle and busy", () => {
    expect(computeStatusText({ message: "" }, 0, " · BG 1 running")).toBe("UCODE · Ready · BG 1 running");
    expect(computeStatusText({ message: "Working", type: "thinking" }, 0, " · BG 1 running")).toContain("Working · BG 1 running");
  });
});
