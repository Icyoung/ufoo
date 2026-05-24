"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function writeDaemonPid(projectRoot, pid) {
  const runDir = path.join(projectRoot, ".ufoo", "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "ufoo-daemon.pid"), String(pid));
}

describe("daemon stopDaemon", () => {
  let projectRoot;
  let killSpy;

  beforeEach(() => {
    jest.resetModules();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-stop-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });
  });

  afterEach(() => {
    if (killSpy) {
      killSpy.mockRestore();
      killSpy = null;
    }
    fs.rmSync(projectRoot, { recursive: true, force: true });
    jest.dontMock("child_process");
    jest.resetModules();
  });

  function mockProcessLookup(pid) {
    jest.doMock("child_process", () => ({
      spawn: jest.fn(),
      spawnSync: jest.fn((cmd, args) => {
        if (cmd === "ps" && args.includes(String(pid))) {
          return {
            status: 0,
            stdout: `/opt/homebrew/bin/node ${path.join(projectRoot, "bin", "ufoo.js")} daemon start\n`,
          };
        }
        if (cmd === "lsof" && args.includes("-Fn")) {
          return { status: 0, stdout: `p${pid}\nn${projectRoot}\n` };
        }
        return { status: 0, stdout: "" };
      }),
    }));
  }

  test("does not remove pid/runtime state when target daemon remains alive", () => {
    const pid = 43210;
    writeDaemonPid(projectRoot, pid);
    mockProcessLookup(pid);

    killSpy = jest.spyOn(process, "kill").mockImplementation((targetPid, signal) => {
      if (targetPid !== pid) return true;
      if (signal === 0 || signal === undefined) return true;
      const err = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    });

    const { stopDaemon } = require("../../../src/runtime/daemon");
    expect(stopDaemon(projectRoot)).toBe(false);
    expect(fs.readFileSync(path.join(projectRoot, ".ufoo", "run", "ufoo-daemon.pid"), "utf8")).toBe(String(pid));
  });

  test("removes pid/runtime state once target daemon exits", () => {
    const pid = 43211;
    let alive = true;
    writeDaemonPid(projectRoot, pid);
    mockProcessLookup(pid);

    killSpy = jest.spyOn(process, "kill").mockImplementation((targetPid, signal) => {
      if (targetPid !== pid) return true;
      if (signal === 0 || signal === undefined) {
        if (alive) return true;
        const err = new Error("no such process");
        err.code = "ESRCH";
        throw err;
      }
      alive = false;
      return true;
    });

    const { stopDaemon } = require("../../../src/runtime/daemon");
    expect(stopDaemon(projectRoot)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "run", "ufoo-daemon.pid"))).toBe(false);
  });
});
