const { listProjectRuntimes } = require("../../projects/registry");

function readProjectRegistryHandler(_ctx = {}, args = {}) {
  const validate = args.validate !== false;
  const cleanupTmp = args.cleanup_tmp !== false;
  const projects = listProjectRuntimes({
    validate,
    cleanupTmp,
    runtimeDir: args.runtimeDir,
  });

  return {
    count: projects.length,
    projects,
  };
}

module.exports = {
  readProjectRegistryHandler,
};
