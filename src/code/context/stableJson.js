"use strict";

function stableValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  const keys = Object.keys(value).sort();
  const out = {};
  for (const key of keys) {
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableStringify(value) {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value || "");
    }
  }
}

module.exports = {
  stableValue,
  stableStringify,
};
