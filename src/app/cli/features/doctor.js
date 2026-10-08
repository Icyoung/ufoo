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

  reportMcp() {
    try {
      const { inspectCodexMcpConfig } = require("../../../runtime/daemon/mcpConfigure");
      const status = inspectCodexMcpConfig();
      if (!status.configured) return;
      if (status.changed) this.fail(`Codex ufoo MCP config is outdated: ${status.target}; run ufoo mcp configure codex`);
      else console.log("MCP: Codex normal tools and resident wait configuration are current.");
    } catch {
      console.log("MCP: configuration check unavailable; start the daemon and run ufoo mcp configure codex.");
    }
  }

  reportNative() {
    const { probeNativeCapabilities } = require("../../../agents/launch/nativeCapabilities");
    const { loadAgentsData } = require("../../../coordination/state/agentsStore");
    const { getUfooPaths } = require("../../../coordination/state/paths");
    const { listNativeReceipts } = require("../../../coordination/bus/nativeReceipts");
    console.log("Native message delivery:");
    for (const agentType of ["codex", "claude-code"]) {
      const capability = probeNativeCapabilities({ agentType });
      console.log(`- ${agentType}: ${capability.version || "unavailable"} (${capability.supported ? "version compatible; runtime readiness still required" : capability.reason})`);
    }
    const agentsFile = getUfooPaths(process.cwd()).agentsFile;
    if (!fs.existsSync(agentsFile)) return;
    for (const [id, meta] of Object.entries(loadAgentsData(agentsFile).agents)) {
      if (meta.native_delivery) console.log(`- ${id}: ${meta.native_delivery}, ready=${meta.native_delivery_ready === true}${meta.native_delivery_diagnostic ? `, ${meta.native_delivery_diagnostic}` : ""}`);
      const uncertain = listNativeReceipts(process.cwd(), id).filter((receipt) => ["unknown", "inflight"].includes(receipt.state));
      if (uncertain.length) console.log(`- ${id}: ${uncertain.length} uncertain receipt(s); inspect with ufoo bus deliveries ${id}`);
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
    this.reportMcp();
    this.reportNative();

    if (this.failed) {
      console.log("Status: FAILED");
      return false;
    }
    console.log("Status: OK");
    return true;
  }
}

module.exports = RepoDoctor;
