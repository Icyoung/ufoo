"use strict";

const { saveGlobalUcodeConfig } = require("../config");

/**
 * Apply /model show|set against the live session state.
 * Persists ucodeModel to the global config so the next launch keeps it.
 */
function applyUcodeModelCommand(state = {}, result = {}) {
  const action = String((result && result.action) || "").trim().toLowerCase();
  if (action === "show") {
    const model = String((state && state.model) || "").trim() || "(unset)";
    const provider = String((state && state.provider) || "").trim() || "(unset)";
    return {
      ok: true,
      error: "",
      output: [
        `model: ${model}`,
        `provider: ${provider}`,
        "usage: /model <model-id>",
      ].join("\n"),
      model: String((state && state.model) || "").trim(),
    };
  }
  if (action === "set") {
    const next = String((result && result.model) || "").trim();
    if (!next) {
      return {
        ok: false,
        error: "usage: /model [model-id]",
        output: "usage: /model [model-id]",
      };
    }
    const previous = String((state && state.model) || "").trim();
    if (state && typeof state === "object") state.model = next;
    try {
      saveGlobalUcodeConfig({ ucodeModel: next });
    } catch {
      // best-effort persistence
    }
    try {
      process.env.UFOO_UCODE_MODEL = next;
    } catch {
      // ignore env write failures
    }
    const output = previous && previous !== next
      ? `model switched: ${previous} → ${next}`
      : `model set: ${next}`;
    return {
      ok: true,
      error: "",
      output,
      model: next,
      previous,
    };
  }
  return {
    ok: false,
    error: "usage: /model [model-id]",
    output: "usage: /model [model-id]",
  };
}

function suggestUcodeModels(state = {}) {
  const current = String((state && state.model) || "").trim();
  const provider = String((state && state.provider) || "").trim().toLowerCase();
  let defaults = ["gpt-5.4", "gpt-5.3", "o3", "o4-mini"];
  if (provider.includes("anthropic") || provider.includes("claude")) {
    defaults = ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"];
  } else if (provider.includes("kimi") || provider.includes("moonshot")) {
    defaults = ["kimi-k2.5", "moonshot-v1-128k"];
  }
  const ids = [];
  if (current) ids.push(current);
  for (const id of defaults) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => ({
    id,
    desc: id === current ? "current" : "",
  }));
}

module.exports = {
  applyUcodeModelCommand,
  suggestUcodeModels,
};
