const fs = require("fs");
const path = require("path");
const ContextDoctor = require("../context/doctor");

class RepoDoctor {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.failed = false;
  }

  fail(message) {
    console.error(`FAIL: ${message}`);
    this.failed = true;
  }

  run() {
    const contextMod = path.join(this.repoRoot, "modules", "context");

    const contextExists = fs.existsSync(contextMod);
    if (!contextExists) {
      this.fail(`missing ${contextMod}`);
    }

    if (contextExists) {
      const contextDoctor = new ContextDoctor(this.repoRoot);
      const ok = contextDoctor.lintProtocol();
      if (!ok) this.failed = true;
    }

    console.log("=== ufoo doctor ===");
    console.log(`Monorepo: ${this.repoRoot}`);
    console.log("Modules:");
    if (contextExists) {
      console.log(`- context: ${contextMod}`);
    }
    const resources = path.join(this.repoRoot, "modules", "resources");
    if (fs.existsSync(resources)) {
      console.log(`- resources: ${resources}`);
    }

    if (this.failed) {
      console.log("Status: FAILED");
      return false;
    }
    console.log("Status: OK");
    return true;
  }
}

module.exports = RepoDoctor;
