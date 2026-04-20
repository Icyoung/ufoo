const path = require('path');
const { ensureDir, appendJSONL, getTimestamp } = require('../bus/utils');

class MemoryManager {
  constructor() {
    this.memoryDir = path.join(process.cwd(), '.ufoo', 'memory');
    this.memoryFile = path.join(this.memoryDir, 'memory.jsonl');
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
