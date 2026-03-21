const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildStatus } = require("../../../src/daemon/status");
const { getUfooPaths } = require("../../../src/ufoo/paths");
const { appendControllerInboxEntry, normalizeReportInput } = require("../../../src/report/store");

describe("daemon status", () => {
  test("includes controller private inbox pending count", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const paths = getUfooPaths(projectRoot);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents: {} }, null, 2));
      appendControllerInboxEntry(projectRoot, "ufoo-agent", normalizeReportInput({
        phase: "done",
        task_id: "brief-1",
        agent_id: "codex:1",
        summary: "delivered",
        scope: "private",
        controller_id: "ufoo-agent",
      }));

      const status = buildStatus(projectRoot);
      expect(status.controller.pending_total).toBe(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
