const ContextDoctor = require("./doctor");
const DecisionsManager = require("./decisions");

/**
 * Context management wrapper for chat commands
 */
class UfooContext {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.doctorInstance = new ContextDoctor(projectRoot);
    this.decisionsManager = new DecisionsManager(projectRoot);
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
    console.log(`Context: ${openDecisions.length} open decision(s), ${decisions.length} total`);
  }
}

module.exports = UfooContext;
