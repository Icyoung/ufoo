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

  test("returns empty status when bus file is missing", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const status = buildStatus(projectRoot);
      expect(status.subscribers).toEqual([]);
      expect(status.active).toEqual([]);
      expect(status.unread.total).toBe(0);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("counts unread messages across queues", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const paths = getUfooPaths(projectRoot);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents: {} }, null, 2));

      const queueDir = path.join(paths.busQueuesDir, "codex_abc");
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, "pending.jsonl"), '{"data":"a"}\n{"data":"b"}\n');

      const status = buildStatus(projectRoot);
      expect(status.unread.total).toBe(2);
      expect(status.unread.perSubscriber["codex_abc"]).toBe(2);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("counts open decisions", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const paths = getUfooPaths(projectRoot);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents: {} }, null, 2));

      const decisionsDir = path.join(projectRoot, ".ufoo", "context", "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.writeFileSync(path.join(decisionsDir, "0001-a.md"), "---\nstatus: open\n---\n# A");
      fs.writeFileSync(path.join(decisionsDir, "0002-b.md"), "---\nstatus: resolved\n---\n# B");

      const status = buildStatus(projectRoot);
      expect(status.decisions.open).toBe(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("normalizes cron tasks", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const paths = getUfooPaths(projectRoot);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents: {} }, null, 2));

      const status = buildStatus(projectRoot, {
        cronTasks: [{ id: "c1", mode: "interval", intervalMs: 5000, prompt: "check" }],
      });
      expect(status.cron.count).toBe(1);
      expect(status.cron.tasks[0].id).toBe("c1");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("reads group state", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const paths = getUfooPaths(projectRoot);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents: {} }, null, 2));

      const groupsDir = path.join(projectRoot, ".ufoo", "groups");
      fs.mkdirSync(groupsDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupsDir, "test-group.json"),
        JSON.stringify({
          group_id: "test-group",
          status: "active",
          template_alias: "build-lane",
          updated_at: "2024-01-01T00:00:00Z",
          members: [{ status: "active" }, { status: "stopped" }],
        })
      );

      const status = buildStatus(projectRoot);
      expect(status.groups.count).toBe(1);
      expect(status.groups.active).toBe(1);
      expect(status.groups.items[0].members_total).toBe(2);
      expect(status.groups.items[0].members_active).toBe(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("filters hidden ufoo-agent subscribers", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-status-"));
    try {
      const paths = getUfooPaths(projectRoot);
      fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
      fs.writeFileSync(
        paths.agentsFile,
        JSON.stringify({
          agents: {
            "ufoo-agent": { status: "active", nickname: "ufoo-agent" },
            "codex:abc": { status: "active", nickname: "builder" },
          },
        }, null, 2)
      );

      const status = buildStatus(projectRoot);
      // ufoo-agent should be filtered from active list
      expect(status.active).not.toContain("ufoo-agent");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
