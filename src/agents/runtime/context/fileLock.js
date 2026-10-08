const fs = require("fs");
const path = require("path");
const lockfile = require("proper-lockfile");

const held = new Set();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Keep the existing synchronous store APIs. Critical sections may only contain
// synchronous local file work; never hold these locks across an await or RPC.
function withFileLock(file, callback, options = {}) {
  const key = path.resolve(file);
  const lockKey = options.lockfilePath ? path.resolve(options.lockfilePath) : key;
  if (held.has(lockKey)) return callback();
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const deadline = Date.now() + 11000;
  let release;
  while (!release) {
    try {
      release = lockfile.lockSync(key, { realpath: false, stale: 10000, ...options });
    } catch (error) {
      if (error.code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
  held.add(lockKey);
  try {
    const result = callback();
    if (result && typeof result.then === "function") throw new Error("File transactions must be synchronous");
    return result;
  } finally {
    held.delete(lockKey);
    release();
  }
}

module.exports = { withFileLock };
