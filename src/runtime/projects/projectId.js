const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function trimTrailingSlashes(value) {
  if (!value) return value;
  return value.replace(/\/+$/, "") || "/";
}

function canonicalProjectRoot(projectRoot) {
  const input = String(projectRoot || "").trim();
  if (!input) {
    throw new Error("projectRoot is required");
  }
  const resolved = path.resolve(input);
  const canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  return trimTrailingSlashes(canonical);
}

function buildProjectId(projectRoot) {
  const canonical = canonicalProjectRoot(projectRoot);
  return crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}

module.exports = {
  trimTrailingSlashes,
  canonicalProjectRoot,
  buildProjectId,
};
