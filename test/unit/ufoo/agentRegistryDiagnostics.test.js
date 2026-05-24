"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

describe("agent registry diagnostics", () => {
  let dir;
  let filePath;

  beforeEach(() => {
    jest.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-registry-diagnostics-"));
    filePath = path.join(dir, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ agents: {} }), "utf8");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.resetModules();
  });

  test("deduplicates repeated queue recovery diagnostics in one process", () => {
    const {
      appendAgentRegistryDiagnostic,
      getRegistryLogPath,
    } = require("../../../src/coordination/state/agentRegistryDiagnostics");

    const payload = {
      subscriber: "ufoo-agent:abc",
      reason: "non_controller_queue_without_registry_entry",
    };

    appendAgentRegistryDiagnostic(filePath, "queue_entry_not_recovered", payload);
    appendAgentRegistryDiagnostic(filePath, "queue_entry_not_recovered", payload);

    const lines = fs.readFileSync(getRegistryLogPath(filePath), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "queue_entry_not_recovered",
      subscriber: "ufoo-agent:abc",
    });
  });
});
