"use strict";

const { createHash } = require("crypto");
const { stableStringify } = require("../core/stableJson");
const { version } = require("../../../../package.json");

function observationFingerprint(value) {
  return createHash("sha256").update(stableStringify(value) || "null").digest("hex");
}

// Configuration evidence only: no credentials, headers, URLs or prompt bodies.
function buildRunObservation({ provider = "", model = "", transport = "", thinkingLevel = "",
  systemPrompt = "", systemBlocks = null, prompt = "", tools = [], resume = false, executionKind = "native", engineFingerprint = null, requestKind = "unknown" } = {}) {
  const config = { version: 1, runtimeVersion: version, engineFingerprint, executionKind, provider, model, transport,
    thinkingLevel, requestKind, resumed: Boolean(resume),
    promptFingerprint: observationFingerprint(systemBlocks || systemPrompt),
    inputFingerprint: prompt ? observationFingerprint(prompt) : null,
    toolSchemaFingerprint: tools.length ? observationFingerprint(tools) : null,
    toolCount: executionKind === "sdk" && !tools.length ? null : tools.length,
    toolInventoryScope: executionKind === "sdk" ? "ufoo-exposed" : "runtime" };
  return { ...config, configurationFingerprint: observationFingerprint({ ...config, inputFingerprint: undefined, resumed: undefined }) };
}

module.exports = { buildRunObservation, observationFingerprint };
