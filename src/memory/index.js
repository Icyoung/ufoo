const { ensureDir, appendJSONL, getTimestamp } = require("../bus/utils");
const { canonicalProjectRoot } = require("../projects/projectId");
const { getUfooPaths } = require("../ufoo/paths");

class MemoryManager {
  constructor(projectRoot) {
    // Phase 0 scaffolding only: this seam must stay dormant until loop/runtime
    // wiring passes an explicit projectRoot into the memory tool path.
    this.projectRoot = canonicalProjectRoot(projectRoot);
    const paths = getUfooPaths(this.projectRoot);
    this.memoryDir = paths.memoryDir;
    this.memoryFile = paths.memoryFile;
    ensureDir(this.memoryDir);
  }

  addEntry(entry) {
    appendJSONL(this.memoryFile, {
      timestamp: getTimestamp(),
      ...entry,
    });
  }
}

module.exports = MemoryManager;
