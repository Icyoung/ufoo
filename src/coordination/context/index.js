const ContextDoctor = require("./doctor");
const DecisionsManager = require("./decisions");
const SyncManager = require("./sync");

/**
 * Context management wrapper for chat commands
 */
class UfooContext {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.doctorInstance = new ContextDoctor(projectRoot);
    this.decisionsManager = new DecisionsManager(projectRoot);
    this.syncManager = new SyncManager(projectRoot);
  }

  /**
   * Run doctor check
   */
  async doctor() {
    await this.doctorInstance.run({ mode: "project", projectPath: this.projectRoot });
  }

  /**
   * List decisions
   */
  async listDecisions() {
    this.decisionsManager.list({ status: "open" });
  }

  /**
   * Get context status
   */
  async status() {
    const decisions = this.decisionsManager.readDecisions();
    const openDecisions = decisions.filter(d => d.status === "open");
    const sync = this.syncManager.parseLines();
    console.log(`Context: ${openDecisions.length} open decision(s), ${decisions.length} total, ${sync.length} sync note(s)`);
  }

  /**
   * Append a sync note
   */
  async syncWrite(options = {}) {
    return this.syncManager.write(options);
  }

  /**
   * Show sync notes
   */
  async listSync(options = {}) {
    return this.syncManager.list(options);
  }
}

module.exports = UfooContext;
