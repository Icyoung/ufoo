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

  reportEngines() {
    console.log("Worker engines (SDK + ACP + Native):");
    console.log("- native: ucode (bundled)");
    console.log("- sdk: codex (@openai/codex-sdk), claude (@anthropic-ai/claude-agent-sdk)");
    try {
      const { detectInstalledAcpAgents } = require("../../../agents/providers/acpRegistry");
      const acpAgents = detectInstalledAcpAgents(process.cwd());
      if (acpAgents.length === 0) {
        console.log("- acp: none detected (configure custom entries via acpAgents in ~/.ufoo/config.json)");
      } else {
        for (const item of acpAgents) {
          console.log(`- acp:${item.id} (${item.label}): ${item.available ? `ready (${item.command})` : "not installed"}`);
        }
      }
    } catch {
      console.log("- acp: registry not initialized");
    }
  }

  reportBrowser() {
    try {
      const { computeBrowserSetupStatus } = require("../../../runtime/browser/installState");
      const { checkNativeHostHealth } = require("../../../runtime/browser/nativeHost");
      const status = computeBrowserSetupStatus();
      console.log("Browser:");
      console.log(`- state: ${status.state} (setupChoice=${status.setupChoice}, enabled=${status.enabled ? "yes" : "no"}, backend=${status.backend})`);
      if (status.runtimeInstalled) {
        const hostHealth = checkNativeHostHealth();
        console.log(`- runtime: ${status.runtimeVersion} (${status.activeEntryPath})`);
        console.log(`- native-host: ${hostHealth.ok ? "ok" : hostHealth.issues.join(", ")}`);
        if (!hostHealth.ok) console.log("- fix: run `ufoo browser doctor`");
      } else {
        console.log("- note: optional component; run `ufoo setup` or `ufoo browser install` if needed.");
      }
    } catch (err) {
      console.log(`Browser: unavailable (${err && err.message ? err.message : err})`);
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
    this.reportEngines();
    this.reportBrowser();

    if (this.failed) {
      console.log("Status: FAILED");
      return false;
    }
    console.log("Status: OK");
    return true;
  }
}

module.exports = RepoDoctor;
