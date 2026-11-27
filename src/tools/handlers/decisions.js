"use strict";

const DecisionsManager = require("../../coordination/context/decisions");

function updateDecisionHandler(ctx = {}, args = {}) {
  const file = String(args.file || "").trim();
  const status = String(args.status || "").trim().toLowerCase();
  const reason = String(args.reason || "").trim();
  if (!file) {
    return { ok: false, code: "invalid_arguments", error: "update_decision requires file" };
  }
  if (!DecisionsManager.VALID_STATUSES.includes(status)) {
    return {
      ok: false,
      code: "invalid_arguments",
      error: `update_decision status must be one of: ${DecisionsManager.VALID_STATUSES.join(", ")}`,
    };
  }
  const manager = new DecisionsManager(ctx.projectRoot);
  const updated = manager.setStatus(file, status, {
    actor: ctx.subscriber || "ufoo-agent",
    reason,
  });
  return {
    ok: true,
    file: updated.file,
    status: updated.status,
    title: updated.title,
    reason: updated.reason,
  };
}

module.exports = {
  updateDecisionHandler,
};
