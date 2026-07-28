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

  reportTui() {
    try {
      const { resolveTuiLaunchPlan, resolveUfooTuiBinary } = require("../../../ui/tuiLauncher");
      const binary = resolveUfooTuiBinary();
      const plan = resolveTuiLaunchPlan({ mode: process.env.UFOO_TUI || "auto" });
      console.log("TUI:");
      console.log(`- UFOO_TUI=${process.env.UFOO_TUI || "auto"} → ${plan.mode} (${plan.reason})`);
      if (binary) {
        console.log(`- binary: ${binary}${plan.version ? ` (${plan.version})` : ""}`);
      } else {
        console.log("- binary: missing (required; Ink TUI removed)");
      }
      console.log("- force: UFOO_TUI=rust | UFOO_TUI_BIN=/path/to/ufoo-tui");
      if (plan.mode === "error") {
        console.log(`- note: chat/ucode will fail until ufoo-tui is built (${plan.reason})`);
      }
    } catch (err) {
      console.log(`TUI: unavailable (${err && err.message ? err.message : err})`);
    }
  }

  run() {
    const skillsDir = path.join(this.repoRoot, "SKILLS");
    const contextSkill = path.join(skillsDir, "ufoo-context", "SKILL.md");
    const busSkill = path.join(skillsDir, "ufoo-bus", "SKILL.md");

    if (!fs.existsSync(contextSkill)) this.fail(`missing ${contextSkill}`);
    if (!fs.existsSync(busSkill)) this.fail(`missing ${busSkill}`);

    const contextDoctor = new ContextDoctor(this.repoRoot);
    const ok = contextDoctor.lintProtocol();
    if (!ok) this.failed = true;

    console.log("=== ufoo doctor ===");
    console.log(`Monorepo: ${this.repoRoot}`);
    console.log("Skills:");
    if (fs.existsSync(contextSkill)) console.log(`- ufoo-context: ${contextSkill}`);
    if (fs.existsSync(busSkill)) console.log(`- ufoo-bus: ${busSkill}`);
    this.reportTui();

    if (this.failed) {
      console.log("Status: FAILED");
      return false;
    }
    console.log("Status: OK");
    return true;
  }
}

module.exports = RepoDoctor;
