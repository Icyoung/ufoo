"use strict";

/**
 * Lightweight, framework-free coverage for UcodeApp. We can't render with
 * ink-testing-library here because jest runs in CJS mode and ink/ink-testing-
 * library are ESM-only — that path would force --experimental-vm-modules on
 * the whole suite. Real TTY render coverage is handled manually; component
 * behaviour is pinned with focused unit tests.
 *
 * Here we just confirm the factory is callable and produces a React function
 * component.
 */

const { createUcodeApp, collapseThinkingTail, resolveLogLineTextProps } = require("../../../src/ui/ink/UcodeApp");

describe("createUcodeApp", () => {
  test("returns a render function when given a React + stub ink namespace", () => {
    const React = require("react");
    const ink = {
      Box: () => null,
      Text: () => null,
      Static: () => null,
      useInput: () => undefined,
      useApp: () => ({ exit: () => {} }),
      useStdout: () => ({ stdout: null }),
    };
    const props = {
      runSingleCommand: () => ({ kind: "empty" }),
      runNaturalLanguageTask: async () => ({ ok: true, summary: "ok" }),
      runUbusCommand: async () => ({ ok: false, error: "stub", summary: "" }),
      formatNlResult: () => "ok",
      workspaceRoot: "/tmp/ufoo-test",
      state: { model: "test-model", sessionId: "ut", engine: "ufoo-core" },
      autoBus: { enabled: false, getPendingCount: () => 0, subscriberId: "" },
    };
    const UcodeApp = createUcodeApp({ React, ink, props, interactive: false });
    expect(typeof UcodeApp).toBe("function");
    expect(UcodeApp.length).toBeLessThanOrEqual(2);
  });
});

describe("collapseThinkingTail", () => {
  test("collapses whitespace runs into single spaces", () => {
    expect(collapseThinkingTail("step one\n\n  step\ttwo   \n step three"))
      .toBe("step one step two step three");
  });

  test("keeps only the tail when longer than maxChars", () => {
    const text = "x".repeat(50) + " " + "y".repeat(60);
    const tail = collapseThinkingTail(text, 40);
    expect(tail).toHaveLength(40);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("y".repeat(39))).toBe(true);
    expect(collapseThinkingTail("short", 40)).toBe("short");
  });

  test("prefers the latest markdown emphasis segment", () => {
    expect(collapseThinkingTail(
      "**Planning code inspection** **Identifying duplicate skill injection and prompt bloat**",
      80,
    )).toBe("Identifying duplicate skill injection and prompt bloat");
  });

  test("handles empty and non-string input", () => {
    expect(collapseThinkingTail("")).toBe("");
    expect(collapseThinkingTail("   \n  ")).toBe("");
    expect(collapseThinkingTail(null)).toBe("");
    expect(collapseThinkingTail(undefined)).toBe("");
  });

  test("falls back to the default limit for invalid maxChars", () => {
    const text = "z".repeat(200);
    expect(collapseThinkingTail(text)).toHaveLength(80);
    expect(collapseThinkingTail(text).startsWith("…")).toBe(true);
    expect(collapseThinkingTail(text, 0)).toHaveLength(80);
    expect(collapseThinkingTail(text, "nope")).toHaveLength(80);
  });
});

// --- Log line kind coloring -------------------------------------------------
//
// UcodeApp is a plain closure component, so a position-indexed hooks stub is
// enough to invoke it directly and inspect the returned React element tree —
// no ink mount needed. This keeps the "framework-free" constraint above while
// still pinning the kind → <Text> props wiring end to end.

function createHarness(propsOverrides = {}) {
  const React = require("react");
  const slots = [];
  let cursor = 0;
  const stubReact = {
    ...React,
    useState(init) {
      const index = cursor++;
      if (slots.length <= index) slots[index] = typeof init === "function" ? init() : init;
      return [slots[index], (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      }];
    },
    useEffect() {},
    useCallback(fn) { return fn; },
    useRef(init) {
      const index = cursor++;
      if (slots.length <= index) slots[index] = { current: init };
      return slots[index];
    },
    useMemo(fn) { return fn(); },
  };
  const ink = {
    Box: () => null,
    Text: () => null,
    Static: () => null,
    useInput: () => undefined,
    useApp: () => ({ exit: () => {} }),
    useStdout: () => ({ stdout: null }),
  };
  const props = {
    runSingleCommand: () => ({ kind: "empty" }),
    runNaturalLanguageTask: async () => ({ ok: true, summary: "ok" }),
    runUbusCommand: async () => ({ ok: false, error: "stub", summary: "" }),
    formatNlResult: () => "ok",
    workspaceRoot: "/tmp/ufoo-test",
    state: { model: "test-model", sessionId: "ut", engine: "ufoo-core" },
    autoBus: { enabled: false, getPendingCount: () => 0, subscriberId: "" },
    ...propsOverrides,
  };
  const UcodeApp = createUcodeApp({ React: stubReact, ink, props, interactive: false });
  return {
    ink,
    slots,
    render() {
      cursor = 0;
      return UcodeApp();
    },
  };
}

function walkElements(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => walkElements(child, visit));
    return;
  }
  visit(node);
  walkElements(node.props && node.props.children, visit);
}

// The scrollback is the first child Box of the root column; its children are
// the per-line <Text> elements.
function collectLogRows(tree, TextType) {
  const rows = [];
  walkElements(tree.props.children[0], (el) => {
    if (el.type === TextType) rows.push(el.props);
  });
  return rows;
}

function findRow(rows, text) {
  return rows.find((row) => row.children === text);
}

async function submitLine(tree, value) {
  let input = null;
  walkElements(tree, (el) => {
    if (!input && el.props && typeof el.props.onSubmit === "function" && typeof el.props.promptPrefix === "string") {
      input = el;
    }
  });
  input.props.onSubmit(value);
  // executeLine runs on a promise chain; flush micro + macrotasks.
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function getLogLines(slots) {
  return slots.find((slot) =>
    Array.isArray(slot) && slot.length > 0 &&
    slot.every((it) => it && typeof it === "object" && typeof it.id === "string" && "text" in it));
}

describe("resolveLogLineTextProps", () => {
  test("maps every log kind to its ink Text props", () => {
    expect(resolveLogLineTextProps("user")).toEqual({ color: "green", bold: true });
    expect(resolveLogLineTextProps("assistant")).toEqual({});
    expect(resolveLogLineTextProps("system")).toEqual({ color: "gray", dimColor: true });
    expect(resolveLogLineTextProps("error")).toEqual({ color: "red" });
    expect(resolveLogLineTextProps("toolDetail")).toEqual({ color: "gray", dimColor: true });
    expect(resolveLogLineTextProps("bus")).toEqual({ color: "cyan" });
  });

  test("unknown or missing kinds fall back to uncolored", () => {
    expect(resolveLogLineTextProps(undefined)).toEqual({});
    expect(resolveLogLineTextProps("")).toEqual({});
    expect(resolveLogLineTextProps("banner")).toEqual({});
  });
});

describe("log line kinds", () => {
  test("banner rows render without Text color props (embedded ANSI preserved)", () => {
    const harness = createHarness();
    const rows = collectLogRows(harness.render(), harness.ink.Text);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.color).toBeUndefined();
      expect(row.bold).toBeUndefined();
      expect(row.dimColor).toBeUndefined();
    }
  });

  test("user prompt rows render green + bold and are stored with kind user", async () => {
    const harness = createHarness();
    await submitLine(harness.render(), "hello world");
    const tree = harness.render();
    const row = findRow(collectLogRows(tree, harness.ink.Text), "› hello world");
    expect(row).toBeDefined();
    expect(row.color).toBe("green");
    expect(row.bold).toBe(true);
    const stored = getLogLines(harness.slots).find((line) => line.text === "› hello world");
    expect(stored.kind).toBe("user");

    // User turns get a blank line of breathing room above and below.
    let userBox = null;
    walkElements(tree.props.children[0], (el) => {
      if (
        !userBox
        && el.type === harness.ink.Box
        && el.props
        && el.props.children
        && el.props.children.props
        && el.props.children.props.children === "› hello world"
      ) {
        userBox = el.props;
      }
    });
    expect(userBox).toBeDefined();
    expect(userBox.marginTop).toBe(1);
    expect(userBox.marginBottom).toBe(1);
  });

  test("error rows render red", async () => {
    const harness = createHarness({
      runSingleCommand: () => { throw new Error("boom"); },
    });
    await submitLine(harness.render(), "whatever");
    const row = findRow(collectLogRows(harness.render(), harness.ink.Text), "Error: boom");
    expect(row).toBeDefined();
    expect(row.color).toBe("red");
  });

  test("bus message rows render cyan", async () => {
    const harness = createHarness({
      runSingleCommand: () => ({ kind: "ubus" }),
      runUbusCommand: async (state, opts) => {
        opts.onMessageReceived({ from: "agent-fox", task: "ship it" });
        return { ok: true, handled: 1, messageExchanges: [{ from: "claude-code:abc", reply: "done" }] };
      },
    });
    await submitLine(harness.render(), "/ubus");
    const rows = collectLogRows(harness.render(), harness.ink.Text);
    expect(findRow(rows, "agent-fox: ship it").color).toBe("cyan");
    expect(findRow(rows, "@claude done").color).toBe("cyan");
  });

  test("system rows render dim gray", async () => {
    const harness = createHarness({
      runSingleCommand: () => ({ kind: "ubus" }),
      runUbusCommand: async () => ({ ok: true, handled: 0, messageExchanges: [] }),
    });
    await submitLine(harness.render(), "/ubus");
    const row = findRow(collectLogRows(harness.render(), harness.ink.Text), "ubus: no pending messages.");
    expect(row).toBeDefined();
    expect(row.color).toBe("gray");
    expect(row.dimColor).toBe(true);
  });

  test("renders streamed deltas after resuming a pending user interaction", async () => {
    const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
    const { requestUserInteraction } = require("../../../src/code/context/userInteraction");
    const executionState = emptyExecutionState();
    requestUserInteraction(executionState, {
      kind: "chat",
      prompt: "Continue?",
      resume: { call: { source: { id: "call_ask" } } },
    });

    const deltas = [];
    const harness = createHarness({
      state: {
        model: "test-model",
        sessionId: "ut-resume",
        engine: "ufoo-core",
        executionState,
      },
      submitUserInteractionAnswer: async (_answer, _state, opts) => {
        if (opts && typeof opts.onDelta === "function") {
          opts.onDelta("Hello ");
          opts.onDelta("after resume");
          deltas.push("Hello ", "after resume");
        }
        return {
          ok: true,
          summary: "should not appear when streamed",
          streamed: true,
          waitingUserInteraction: false,
          shouldEchoSummary: false,
        };
      },
    });

    await submitLine(harness.render(), "yes continue");
    const lines = getLogLines(harness.slots).map((line) => line.text);
    expect(lines).toContain("› yes continue");
    expect(lines.some((text) => text.includes("Hello"))).toBe(true);
    expect(lines.some((text) => text.includes("after resume"))).toBe(true);
    expect(lines).not.toContain("should not appear when streamed");
    expect(deltas).toEqual(["Hello ", "after resume"]);
  });
});
