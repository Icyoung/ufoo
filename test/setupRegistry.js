const fs = require("fs");
const os = require("os");
const path = require("path");

// Lifecycle tests activate temporary projects. Never persist those fixtures in
// the user's real registry, including operations running in child processes.
const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-test-registry-"));
const previous = process.env.UFOO_PROJECT_RUNTIME_DIR;
process.env.UFOO_PROJECT_RUNTIME_DIR = registryDir;
afterAll(() => {
  fs.rmSync(registryDir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.UFOO_PROJECT_RUNTIME_DIR;
  else process.env.UFOO_PROJECT_RUNTIME_DIR = previous;
});
