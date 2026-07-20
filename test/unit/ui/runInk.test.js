"use strict";

const { resolveInkRenderOptions } = require("../../../src/ui/runInk");

describe("resolveInkRenderOptions", () => {
  test("patchConsole defaults to true so stray console output cannot tear frames", () => {
    expect(resolveInkRenderOptions({}).patchConsole).toBe(true);
    expect(resolveInkRenderOptions({ patchConsole: true }).patchConsole).toBe(true);
    expect(resolveInkRenderOptions({ patchConsole: false }).patchConsole).toBe(false);
  });

  test("exitOnCtrlC defaults to true unless explicitly disabled", () => {
    expect(resolveInkRenderOptions({}).exitOnCtrlC).toBe(true);
    expect(resolveInkRenderOptions({ exitOnCtrlC: false }).exitOnCtrlC).toBe(false);
  });

  test("explicit stdio overrides are preserved", () => {
    const stdin = {};
    const stdout = {};
    const stderr = {};
    const resolved = resolveInkRenderOptions({ stdin, stdout, stderr });
    expect(resolved.stdin).toBe(stdin);
    expect(resolved.stdout).toBe(stdout);
    expect(resolved.stderr).toBe(stderr);
  });
});
