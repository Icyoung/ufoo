const os = require("os");
const path = require("path");
const { canonicalProjectRoot, trimTrailingSlashes } = require("./projectId");

function normalizeProjectRoot(projectRoot) {
  const input = String(projectRoot || "").trim();
  if (!input) return "";
  try {
    return canonicalProjectRoot(input);
  } catch {
    return trimTrailingSlashes(path.resolve(input));
  }
}

function resolveGlobalControllerProjectRoot() {
  return trimTrailingSlashes(path.resolve(os.homedir()));
}

function resolveGlobalControllerUfooDir() {
  return path.join(resolveGlobalControllerProjectRoot(), ".ufoo");
}

function isGlobalControllerProjectRoot(projectRoot) {
  const normalized = normalizeProjectRoot(projectRoot);
  return Boolean(normalized) && normalized === resolveGlobalControllerProjectRoot();
}

module.exports = {
  normalizeProjectRoot,
  resolveGlobalControllerProjectRoot,
  resolveGlobalControllerUfooDir,
  isGlobalControllerProjectRoot,
};
