"use strict";

function isContextV2Enabled(env = process.env) {
  const raw = String(env.UFOO_UCODE_CONTEXT_V2 || "").trim().toLowerCase();
  // Default ON. Explicit opt-out: 0 / false / off / no.
  if (!raw) return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

module.exports = {
  isContextV2Enabled,
};
