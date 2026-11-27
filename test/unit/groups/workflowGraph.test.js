"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  connectWorkflowEdge,
  disconnectWorkflowEdge,
  disbandAdhocGroup,
  renameAdhocGroup,
  getWorkflowSnapshot,
  resolveWorkflowForwardTargets,
  saveNodePositions,
  readNodePositions,
} = require("../../../src/orchestration/groups/workflowGraph");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function setupProject(agents = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-wf-"));
  const paths = getUfooPaths(tmp);
  fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
  fs.mkdirSync(paths.busDir, { recursive: true });
  fs.mkdirSync(paths.groupsDir, { recursive: true });
  fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents }, null, 2), "utf8");
  return tmp;
}

describe("Multi workflow graph & ad-hoc temporary group engine", () => {
  test("connecting 2+ agents auto-forms a temporary ad-hoc group, forwards safely, and auto-dissolves on disconnect", () => {
    const root = setupProject({
      "codex:a": { status: "active", pid: process.pid, agent_type: "codex", nickname: "codex-1", launch_mode: "internal" },
      "claude:b": { status: "active", pid: process.pid, agent_type: "claude", nickname: "claude-1", launch_mode: "internal" },
      "ucode:c": { status: "active", pid: process.pid, agent_type: "ucode", nickname: "ucode-1", launch_mode: "internal" },
    });

    try {
      // Initial snapshot has no groups or edges
      expect(getWorkflowSnapshot(root).groups).toEqual([]);
      expect(getWorkflowSnapshot(root).edges).toEqual([]);

      // Connect A -> B -> auto-forms ad-hoc group
      const first = connectWorkflowEdge(root, { from: "codex:a", to: "claude:b" });
      expect(first.ok).toBe(true);
      expect(first.created_group).toBe(true);
      expect(first.group_id).toMatch(/^adhoc-/);
      expect(first.snapshot.groups).toHaveLength(1);
      expect(first.snapshot.groups[0]).toMatchObject({
        group_id: first.group_id,
        origin: "adhoc",
        readonly: false,
        member_ids: ["codex:a", "claude:b"],
      });

      // agents.json updated with group_id + template_alias "adhoc"
      const agentsAfterFirst = JSON.parse(fs.readFileSync(getUfooPaths(root).agentsFile, "utf8")).agents;
      expect(agentsAfterFirst["codex:a"].group_id).toBe(first.group_id);
      expect(agentsAfterFirst["claude:b"].group_id).toBe(first.group_id);
      expect(agentsAfterFirst["ucode:c"].group_id).toBeUndefined();

      // Connect B -> C -> expands same ad-hoc group
      const second = connectWorkflowEdge(root, { from: "claude:b", to: "ucode:c" });
      expect(second.ok).toBe(true);
      expect(second.created_group).toBe(false);
      expect(second.group_id).toBe(first.group_id);
      expect(second.snapshot.groups[0].member_ids).toEqual(["codex:a", "claude:b", "ucode:c"]);
      expect(second.snapshot.edges).toHaveLength(2);

      // Connect C -> A (cycle) -> forward targets prevent infinite loop via trail
      const cycle = connectWorkflowEdge(root, { from: "ucode:c", to: "codex:a" });
      expect(cycle.ok).toBe(true);

      const hop1 = resolveWorkflowForwardTargets(root, "codex:a", { workflow_hop: 0, workflow_trail: [] });
      expect(hop1).toHaveLength(1);
      expect(hop1[0]).toMatchObject({ from: "codex:a", to: "claude:b", next_hop: 1 });

      const hop2 = resolveWorkflowForwardTargets(root, "claude:b", {
        workflow_hop: hop1[0].next_hop,
        workflow_trail: hop1[0].next_trail,
      });
      expect(hop2[0]).toMatchObject({ from: "claude:b", to: "ucode:c", next_hop: 2 });

      const hop3 = resolveWorkflowForwardTargets(root, "ucode:c", {
        workflow_hop: hop2[0].next_hop,
        workflow_trail: hop2[0].next_trail,
      });
      expect(hop3[0]).toMatchObject({ from: "ucode:c", to: "codex:a", next_hop: 3 });

      // Back at codex:a: "codex:a->claude:b" already in trail -> stops cleanly!
      const hop4 = resolveWorkflowForwardTargets(root, "codex:a", {
        workflow_hop: hop3[0].next_hop,
        workflow_trail: hop3[0].next_trail,
      });
      expect(hop4).toEqual([]);

      // Persist & read node positions
      saveNodePositions(root, { "codex:a": { x: 100.4, y: 200.6 } });
      expect(readNodePositions(root)).toEqual({ "codex:a": { x: 100, y: 201 } });

      // Disband removes all temporary edges and clears agents.json group_id
      const disbanded = disbandAdhocGroup(root);
      expect(disbanded.ok).toBe(true);
      expect(disbanded.snapshot.groups).toEqual([]);
      expect(disbanded.snapshot.edges).toEqual([]);
      const agentsAfterDisband = JSON.parse(fs.readFileSync(getUfooPaths(root).agentsFile, "utf8")).agents;
      expect(agentsAfterDisband["codex:a"].group_id).toBe("");
      expect(agentsAfterDisband["claude:b"].group_id).toBe("");

      // Re-connect one edge, then disconnect -> auto-dissolves when 0 edges remain
      const re = connectWorkflowEdge(root, { from: "codex:a", to: "claude:b" });
      expect(re.ok).toBe(true);
      const disc = disconnectWorkflowEdge(root, { edgeId: re.edge_id });
      expect(disc.ok).toBe(true);
      expect(disc.dissolved).toBe(true);
      expect(disc.snapshot.groups).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("projects template group default workflow edges as readonly and blocks manual wiring into template members", () => {
    const root = setupProject({
      "codex:arch": { status: "active", pid: process.pid, agent_type: "codex", nickname: "architect", group_id: "build-lane-1", launch_mode: "internal" },
      "codex:bld": { status: "active", pid: process.pid, agent_type: "codex", nickname: "builder", group_id: "build-lane-1", launch_mode: "internal" },
      "ucode:free": { status: "active", pid: process.pid, agent_type: "ucode", nickname: "ucode-1", launch_mode: "internal" },
    });

    try {
      const groupFile = path.join(getUfooPaths(root).groupsDir, "build-lane-1.json");
      fs.writeFileSync(groupFile, JSON.stringify({
        group_id: "build-lane-1",
        status: "active",
        template_alias: "build-lane",
        template_name: "Build Lane",
        members: [
          { nickname: "architect", subscriber_id: "codex:arch", status: "active", report_to: ["builder"], depends_on: [] },
          { nickname: "builder", subscriber_id: "codex:bld", status: "active", report_to: [], depends_on: ["architect"] },
        ],
        edges: [
          { from: "architect", to: "builder", kind: "task" },
        ],
      }, null, 2), "utf8");

      const snap = getWorkflowSnapshot(root);
      expect(snap.groups).toHaveLength(1);
      expect(snap.groups[0]).toMatchObject({
        group_id: "build-lane-1",
        origin: "template",
        readonly: true,
        member_ids: ["codex:arch", "codex:bld"],
      });
      expect(snap.edges).toEqual([
        expect.objectContaining({
          from: "codex:arch",
          to: "codex:bld",
          kind: "task",
          origin: "template",
          readonly: true,
          auto_forward: false,
        }),
      ]);

      // Template members cannot be manually wired into ad-hoc group
      const blocked = connectWorkflowEdge(root, { from: "ucode:free", to: "codex:bld" });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toContain("template group");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists and merges node geometry including custom width and height", () => {
    const root = setupProject();
    try {
      saveNodePositions(root, {
        "ucode:a": { x: 120.4, y: 80.6, w: 480, h: 360 },
        "ucode:b": { x: 600, y: 90, w: 50, h: 2000 },
      });
      const first = readNodePositions(root);
      expect(first["ucode:a"]).toEqual({ x: 120, y: 81, w: 480, h: 360 });
      expect(first["ucode:b"]).toEqual({ x: 600, y: 90, w: 220, h: 900 });

      // Moving a node preserves its previously saved w/h
      saveNodePositions(root, {
        "ucode:a": { x: 200, y: 150 },
      });
      expect(readNodePositions(root)["ucode:a"]).toEqual({ x: 200, y: 150, w: 480, h: 360 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("renames active ad-hoc temporary group and preserves custom name across edge updates", () => {
    const root = setupProject({
      "ucode:a": { status: "active", pid: process.pid, nickname: "a", agent_type: "ucode", launch_mode: "internal" },
      "ucode:b": { status: "active", pid: process.pid, nickname: "b", agent_type: "ucode", launch_mode: "internal" },
      "ucode:c": { status: "active", pid: process.pid, nickname: "c", agent_type: "ucode", launch_mode: "internal" },
    });
    try {
      expect(connectWorkflowEdge(root, { from: "ucode:a", to: "ucode:b" }).ok).toBe(true);
      const renamed = renameAdhocGroup(root, "  Review Pipeline  ");
      expect(renamed.ok).toBe(true);
      expect(renamed.name).toBe("Review Pipeline");
      expect(renamed.snapshot.groups[0].name).toBe("Review Pipeline");

      // Adding another wire preserves the custom name
      const extended = connectWorkflowEdge(root, { from: "ucode:b", to: "ucode:c" });
      expect(extended.ok).toBe(true);
      expect(extended.snapshot.groups[0].name).toBe("Review Pipeline");

      // Empty rename rejected cleanly
      expect(renameAdhocGroup(root, "   ").ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes stale historical groups holding only ufoo-agent or already-claimed reused workers", () => {
    const root = setupProject({
      "ufoo-agent": { status: "active", pid: process.pid, agent_type: "ufoo", nickname: "ufoo" },
      "codex:arch": { status: "active", pid: process.pid, agent_type: "codex", nickname: "architect", group_id: "build-lane-new" },
      "codex:bld": { status: "active", pid: process.pid, agent_type: "codex", nickname: "builder", group_id: "build-lane-new" },
    });
    try {
      const paths = getUfooPaths(root);
      // Old ghost group from months ago referencing ufoo-agent + dead workers
      fs.writeFileSync(path.join(paths.groupsDir, "build-lane-old-ghost.json"), JSON.stringify({
        group_id: "build-lane-old-ghost",
        status: "active",
        template_alias: "build-lane",
        template_name: "Build Lane",
        updated_at: "2026-05-26T00:00:00.000Z",
        members: [
          { nickname: "coordinator", subscriber_id: "ufoo-agent", status: "active" },
          { nickname: "builder", subscriber_id: "codex:dead", status: "stopped" },
        ],
      }, null, 2), "utf8");

      // Older reused-agent group referencing codex:arch before the newer run took ownership
      fs.writeFileSync(path.join(paths.groupsDir, "build-lane-reused-old.json"), JSON.stringify({
        group_id: "build-lane-reused-old",
        status: "active",
        template_alias: "build-lane",
        template_name: "Build Lane",
        updated_at: "2026-10-01T00:00:00.000Z",
        members: [
          { nickname: "architect", subscriber_id: "codex:arch", status: "reused" },
        ],
      }, null, 2), "utf8");

      // Current active group
      fs.writeFileSync(path.join(paths.groupsDir, "build-lane-new.json"), JSON.stringify({
        group_id: "build-lane-new",
        status: "active",
        template_alias: "build-lane",
        template_name: "Build Lane",
        updated_at: "2026-11-26T20:00:00.000Z",
        members: [
          { nickname: "architect", subscriber_id: "codex:arch", status: "active" },
          { nickname: "builder", subscriber_id: "codex:bld", status: "active" },
        ],
        edges: [{ from: "architect", to: "builder", kind: "task" }],
      }, null, 2), "utf8");

      const snap = getWorkflowSnapshot(root);
      expect(snap.groups).toHaveLength(1);
      expect(snap.groups[0].group_id).toBe("build-lane-new");
      expect(snap.groups[0].member_ids).toEqual(["codex:arch", "codex:bld"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
