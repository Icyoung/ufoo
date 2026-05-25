const fs = require("fs");
const path = require("path");
const ContextDoctor = require("../../../coordination/context/doctor");

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
    const skillsDir = path.join(this.repoRoot, "SKILLS");
    const contextSkill = path.join(skillsDir, "uctx", "SKILL.md");
    const busSkill = path.join(skillsDir, "ubus", "SKILL.md");

    if (!fs.existsSync(contextSkill)) this.fail(`missing ${contextSkill}`);
    if (!fs.existsSync(busSkill)) this.fail(`missing ${busSkill}`);

    const contextDoctor = new ContextDoctor(this.repoRoot);
    const ok = contextDoctor.lintProtocol();
    if (!ok) this.failed = true;

    console.log("=== ufoo doctor ===");
    console.log(`Monorepo: ${this.repoRoot}`);
    console.log("Skills:");
    if (fs.existsSync(contextSkill)) console.log(`- uctx: ${contextSkill}`);
    if (fs.existsSync(busSkill)) console.log(`- ubus: ${busSkill}`);

    if (this.failed) {
      console.log("Status: FAILED");
      return false;
    }
    console.log("Status: OK");
    return true;
  }
}

module.exports = RepoDoctor;
