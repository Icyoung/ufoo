// Projects module: unified identity + registry + runtimes interface
module.exports = {
  // Identity functions (path canonicalization, global mode detection)
  ...require("./identity"),
  // Project ID generation
  ...require("./projectId"),
  // Project registry (CRUD runtime state)
  ...require("./registry"),
  // Project runtimes utilities (filtering, sorting, formatting)
  ...require("./runtimes"),
};
