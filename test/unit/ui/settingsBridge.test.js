"use strict";

const {
  MODE_OPTIONS,
  PROVIDER_OPTIONS,
  buildSettingsSnapshot,
} = require("../../../src/ui/settingsBridge");

describe("settingsBridge", () => {
  test("buildSettingsSnapshot normalizes launch mode and provider", () => {
    const snap = buildSettingsSnapshot({
      launchMode: "terminal",
      agentProvider: "claude-cli",
    });
    expect(MODE_OPTIONS).toContain("terminal");
    expect(PROVIDER_OPTIONS.some((opt) => opt.value === "claude-cli")).toBe(true);
    expect(snap.launch_mode).toBe("terminal");
    expect(snap.agent_provider).toBe("claude-cli");
    expect(snap.mode_options).toEqual(expect.arrayContaining(["auto", "terminal"]));
    expect(snap.provider_options[0]).toHaveProperty("label");
  });
});
