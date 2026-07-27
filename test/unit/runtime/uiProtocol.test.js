"use strict";

const fs = require("fs");
const path = require("path");
const {
  PROTOCOL,
  MULTI_FRAMES_CAPABILITY,
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

  test("encodes interaction and suspend event names", () => {
    const suspend = createEnvelope({
      kind: "event",
      name: "ui.suspend.prepare",
      seq: 9,
      payload: { reason: "agent.open" },
    });
    const ask = createEnvelope({
      kind: "event",
      name: "interaction.request",
      seq: 10,
      payload: { id: "q1", prompt: "Continue?" },
    });
    expect(decodeMessage(encodeMessage(suspend)).ok).toBe(true);
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
  });

  test("registers multi.* commands and events", () => {
    for (const name of ["multi.exit", "multi.focus", "multi.viewport", "multi.raw"]) {
      expect(COMMAND_NAMES).toContain(name);
    }
    for (const name of ["multi.set", "multi.pane.frame"]) {
      expect(EVENT_NAMES).toContain(name);
    }
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
