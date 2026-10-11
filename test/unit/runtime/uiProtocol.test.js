"use strict";

const fs = require("fs");
const path = require("path");
const {
  PROTOCOL,
  MULTI_FRAMES_CAPABILITY,
  WINDOW_MODES_CAPABILITY,
  COMMAND_NAMES,
  EVENT_NAMES,
  createEnvelope,
  validateEnvelope,
  encodeMessage,
  decodeMessage,
  createSeqCounter,
} = require("../../../src/runtime/contracts/uiProtocol");

describe("ufoo-ui/1 protocol", () => {
  test("rejects wrong protocol", () => {
    expect(validateEnvelope({ protocol: "nope", kind: "hello", payload: {} }).ok).toBe(false);
  });

  test("encodes and decodes a command", () => {
    const seq = createSeqCounter();
    const envelope = createEnvelope({
      kind: "command",
      name: "input.submit",
      requestId: "req-1",
      seq: seq.next(),
      scope: { surface: "chat", project_id: "p1", view_id: "main" },
      payload: { text: "hello" },
    });
    const line = encodeMessage(envelope);
    const decoded = decodeMessage(line);
    expect(decoded.ok).toBe(true);
    expect(decoded.envelope.protocol).toBe(PROTOCOL);
    expect(decoded.envelope.name).toBe("input.submit");
    expect(decoded.envelope.payload.text).toBe("hello");
  });

  test("encodes interaction events and rejects retired names from the catalog", () => {
    const ask = createEnvelope({
      kind: "event",
      name: "interaction.request",
      seq: 10,
      payload: { id: "q1", prompt: "Continue?" },
    });
    expect(COMMAND_NAMES).not.toContain("agent.view.submit");
    expect(COMMAND_NAMES).not.toContain("ui.suspend.request");
    expect(EVENT_NAMES).not.toContain("agent.view.open");
    expect(EVENT_NAMES).not.toContain("ui.suspend.prepare");
    expect(decodeMessage(encodeMessage(ask)).envelope.name).toBe("interaction.request");
    const respond = createEnvelope({
      kind: "command",
      name: "interaction.respond",
      requestId: "r1",
      payload: { id: "q1", text: "yes" },
    });
    expect(decodeMessage(encodeMessage(respond)).ok).toBe(true);
  });

  test("encodes prompt.set_prefix event", () => {
    const env = createEnvelope({
      kind: "event",
      name: "prompt.set_prefix",
      seq: 11,
      payload: { prefix: "›@alpha " },
    });
    expect(validateEnvelope(env).ok).toBe(true);
    expect(decodeMessage(encodeMessage(env)).envelope.payload.prefix).toBe("›@alpha ");
  });

  test("accepts project.return_controller command", () => {
    const env = createEnvelope({
      kind: "command",
      name: "project.return_controller",
      requestId: "r2",
      payload: {},
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("exposes multi-frames capability constant", () => {
    expect(MULTI_FRAMES_CAPABILITY).toBe("multi-frames-v1");
    expect(WINDOW_MODES_CAPABILITY).toBe("window-modes-v1");
  });

  test("registers explicit window control and keeps the pane transport", () => {
    for (const name of ["window.set", "window.cycle", "multi.focus", "multi.viewport", "multi.raw"]) {
      expect(COMMAND_NAMES).toContain(name);
    }
    for (const name of ["window.set", "multi.pane.frame"]) {
      expect(EVENT_NAMES).toContain(name);
    }
    for (const name of ["multi.exit", "multi.open", "multi.toggle"]) {
      expect(COMMAND_NAMES).not.toContain(name);
    }
    expect(EVENT_NAMES).not.toContain("multi.set");
  });

  test("encodes multi.pane.frame without seq (lossy)", () => {
    const env = createEnvelope({
      kind: "event",
      name: "multi.pane.frame",
      payload: {
        session_id: "s1",
        viewport_rev: 3,
        agent_id: "agent-1",
        label: "a",
        mode: "socket",
        lines: ["hello"],
      },
    });
    expect(validateEnvelope(env).ok).toBe(true);
    expect(env.seq).toBeUndefined();
    expect(decodeMessage(encodeMessage(env)).envelope.payload.viewport_rev).toBe(3);
  });
});
