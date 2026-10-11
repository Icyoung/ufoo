"use strict";

const {
  PROVIDER_OPTIONS,
  buildSettingsSnapshot,
} = require("../../../src/ui/settingsBridge");

describe("settingsBridge", () => {
  test("buildSettingsSnapshot exposes provider settings without launch modes", () => {
    const snap = buildSettingsSnapshot({
      launchMode: "terminal",
      agentProvider: "claude-cli",
    });
    expect(PROVIDER_OPTIONS.some((opt) => opt.value === "claude-cli")).toBe(true);
    expect(snap).not.toHaveProperty("launch_mode");
    expect(snap.agent_provider).toBe("claude-cli");
    expect(snap).not.toHaveProperty("mode_options");
    expect(snap.provider_options[0]).toHaveProperty("label");
  });
});
