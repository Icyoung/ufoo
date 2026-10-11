"use strict";
const { buildRunObservation } = require("../../../src/agents/runtime/protocol/runObservation");

test("run configuration hashes are stable across argument ordering and never expose prompt bodies or credentials", () => {
  const input = { provider: "custom", model: "test", thinkingLevel: "high", systemPrompt: "private workspace instructions", prompt: "secret task",
    tools: [{ name: "read", input: { b: 1, a: 2 } }], apiKey: "do-not-store-this", requestHeaders: { Authorization: "Bearer do-not-store-this" } };
  const first = buildRunObservation(input);
  expect(buildRunObservation({ ...input, tools: [{ input: { a: 2, b: 1 }, name: "read" }] })).toEqual(first);
  expect(JSON.stringify(first)).not.toMatch(/private workspace|secret task|do-not-store/);
  expect(buildRunObservation({ ...input, thinkingLevel: "low" }).configurationFingerprint).not.toBe(first.configurationFingerprint);
  expect(buildRunObservation({ ...input, systemPrompt: "new instructions" }).promptFingerprint).not.toBe(first.promptFingerprint);
  expect(buildRunObservation({ executionKind: "sdk" }).toolCount).toBeNull();
});
