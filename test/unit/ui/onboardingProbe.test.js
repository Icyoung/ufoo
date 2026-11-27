"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  readOnboardingState,
  saveOnboardingState,
  probeOnboardingState,
  launchLoginInTerminal,
} = require("../../../src/ui/onboardingProbe");

describe("onboardingProbe", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-onboarding-"));
  });

  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("persists completion state and controls should_show based on existing projects", async () => {
    expect(readOnboardingState(tmp).completed).toBe(false);

    const firstProbe = await probeOnboardingState({
      controllerRoot: tmp,
      existingProjectsCount: 0,
      homedir: tmp,
      isExecutable: () => false,
    });
    expect(firstProbe.should_show).toBe(true);
    expect(firstProbe.primary_engines.length).toBeGreaterThanOrEqual(2);
    expect(firstProbe.acp_engines.length).toBeGreaterThanOrEqual(4);

    // Existing users with projects are not interrupted automatically
    const existingUserProbe = await probeOnboardingState({
      controllerRoot: tmp,
      existingProjectsCount: 2,
      homedir: tmp,
      isExecutable: () => false,
    });
    expect(existingUserProbe.should_show).toBe(false);

    saveOnboardingState(tmp, { completed: true, skipped: false });
    expect(readOnboardingState(tmp).completed).toBe(true);

    const afterProbe = await probeOnboardingState({
      controllerRoot: tmp,
      existingProjectsCount: 0,
      homedir: tmp,
      isExecutable: () => false,
    });
    expect(afterProbe.should_show).toBe(false);
  });

  test("launchLoginInTerminal allows only known login commands and rejects arbitrary shell strings", () => {
    expect(launchLoginInTerminal("claude-cli", { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      command: "claude auth login",
    });
    expect(launchLoginInTerminal("codex-cli", { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      command: "codex login",
    });
    const rejected = launchLoginInTerminal("rm -rf /", { dryRun: true });
    expect(rejected.ok).toBe(false);
  });
});
