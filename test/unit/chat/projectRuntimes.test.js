const {
  sortProjectRuntimes,
  parseTimestampMs,
  filterVisibleProjectRuntimes,
} = require("../../../src/projects");

describe("chat projectRuntimes", () => {
  test("parseTimestampMs returns 0 for invalid input", () => {
    expect(parseTimestampMs("")).toBe(0);
    expect(parseTimestampMs("invalid")).toBe(0);
  });

  test("sortProjectRuntimes sorts by interaction recency and does not pin active project first", () => {
    const rows = [
      { project_name: "alpha", project_root: "/tmp/alpha", last_seen: "2026-03-06T10:00:00.000Z" },
      { project_name: "beta", project_root: "/tmp/beta", last_seen: "2026-03-06T11:00:00.000Z" },
      { project_name: "gamma", project_root: "/tmp/gamma", last_seen: "2026-03-06T12:00:00.000Z" },
    ];
    const interactionByRoot = {
      "/tmp/alpha": 100,
      "/tmp/beta": 50,
      "/tmp/gamma": 200,
    };

    const sorted = sortProjectRuntimes({
      rows,
      activeProjectRoot: "/tmp/beta",
      resolveProjectRoot: (row) => row.project_root,
      getInteractionMs: (row) => interactionByRoot[row.project_root] || 0,
    });

    expect(sorted.map((row) => row.project_root)).toEqual([
      "/tmp/gamma",
      "/tmp/alpha",
      "/tmp/beta",
    ]);
  });

  test("sortProjectRuntimes falls back to last_seen when interaction timestamps tie", () => {
    const rows = [
      { project_name: "a", project_root: "/tmp/a", last_seen: "2026-03-06T10:00:00.000Z" },
      { project_name: "b", project_root: "/tmp/b", last_seen: "2026-03-06T12:00:00.000Z" },
    ];

    const sorted = sortProjectRuntimes({
      rows,
      activeProjectRoot: "",
      resolveProjectRoot: (row) => row.project_root,
      getInteractionMs: () => 0,
    });

    expect(sorted.map((row) => row.project_root)).toEqual(["/tmp/b", "/tmp/a"]);
  });

  test("filterVisibleProjectRuntimes hides stopped projects", () => {
    const rows = [
      { project_name: "alpha", project_root: "/tmp/alpha", status: "running" },
      { project_name: "beta", project_root: "/tmp/beta", status: "stopped" },
      { project_name: "gamma", project_root: "/tmp/gamma", status: "stale" },
      { project_name: "delta", project_root: "/tmp/delta", status: "STOPPED" },
    ];

    const visible = filterVisibleProjectRuntimes(rows);
    expect(visible.map((row) => row.project_root)).toEqual([
      "/tmp/alpha",
      "/tmp/gamma",
    ]);
  });
});
