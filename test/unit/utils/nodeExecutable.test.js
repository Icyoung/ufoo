"use strict";

const { resolveNodeExecutable } = require("../../../src/utils/nodeExecutable");

describe("resolveNodeExecutable", () => {
  test("uses current execPath when it still exists", () => {
    const fsModule = { existsSync: jest.fn(() => true) };
    expect(resolveNodeExecutable({
      execPath: "/opt/homebrew/bin/node",
      env: {},
      fsModule,
    })).toBe("/opt/homebrew/bin/node");
  });

  test("falls back to PATH lookup when execPath disappeared", () => {
    const fsModule = { existsSync: jest.fn(() => false) };
    expect(resolveNodeExecutable({
      execPath: "/opt/homebrew/Cellar/node/25.8.0/bin/node",
      env: {},
      fsModule,
    })).toBe("node");
  });

  test("allows explicit override", () => {
    const fsModule = { existsSync: jest.fn(() => false) };
    expect(resolveNodeExecutable({
      execPath: "/missing/node",
      env: { UFOO_NODE_EXECUTABLE: "/custom/node" },
      fsModule,
    })).toBe("/custom/node");
  });
});
