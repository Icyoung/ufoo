const path = require("path");
const { canonicalProjectRoot } = require("../../runtime/projects/projectId");
const { listProjectRuntimes, projectPathExists } = require("../../runtime/projects/registry");
const { buildToolError } = require("./common");

function readProjectRegistryHandler(_ctx = {}, args = {}) {
  const validate = args.validate !== false;
  const cleanupTmp = args.cleanup_tmp !== false;
  const limit = args.limit === undefined ? 100 : args.limit;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000
    || !Number.isInteger(offset) || offset < 0) {
    throw buildToolError("invalid_arguments", "registry limit must be 1..1000 and offset must be nonnegative integers");
  }
  const rows = listProjectRuntimes({
    validate,
    cleanupTmp,
    runtimeDir: args.runtimeDir,
  });
  let root = "";
  if (args.project_root) {
    try { root = canonicalProjectRoot(args.project_root); }
    catch { root = path.resolve(args.project_root); }
  }
  let omittedMissing = 0;
  const filtered = rows.filter((row) => {
    if (root && path.resolve(row.project_root) !== root) return false;
    if (args.include_missing !== true && !projectPathExists(row.project_root)) {
      omittedMissing += 1;
      return false;
    }
    return true;
  });
  const projects = filtered.slice(offset, offset + limit);

  return {
    count: projects.length,
    total: filtered.length,
    next_offset: offset + projects.length < filtered.length ? offset + projects.length : null,
    omitted_missing: omittedMissing,
    projects,
  };
}

module.exports = {
  readProjectRegistryHandler,
};
