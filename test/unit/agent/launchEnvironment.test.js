"use strict";

const {
  detectLaunchEnvironment,
  CANONICAL_LAUNCH_MODES,
} = require("../../../src/agents/launch/launchEnvironment");

describe("detectLaunchEnvironment", () => {
  test("short-circuits on explicit canonical UFOO_LAUNCH_MODE", () => {
    for (const mode of CANONICAL_LAUNCH_MODES) {
      const out = detectLaunchEnvironment({ UFOO_LAUNCH_MODE: mode });
      expect(out).toEqual({ mode, terminalApp: "", source: "explicit" });
    }
  });

  test("explicit overrides every other signal", () => {
    const out = detectLaunchEnvironment({
      UFOO_LAUNCH_MODE: "internal",
      TMUX_PANE: "%0",
      UFOO_HOST_SESSION_ID: "abc",
      TERM_PROGRAM: "Apple_Terminal",
      ITERM_SESSION_ID: "x",
    });
    expect(out.mode).toBe("internal");
    expect(out.source).toBe("explicit");
  });

  test("auto mode is treated as no explicit hint", () => {
    const out = detectLaunchEnvironment({
      UFOO_LAUNCH_MODE: "auto",
      TMUX_PANE: "%0",
    });
    expect(out.mode).toBe("tmux");
    expect(out.source).toBe("auto");
  });

  test("invalid explicit mode falls through to detection", () => {
    const out = detectLaunchEnvironment({
      UFOO_LAUNCH_MODE: "garbage",
      TMUX_PANE: "%0",
    });
    expect(out.mode).toBe("tmux");
    expect(out.source).toBe("auto");
  });

  test("TMUX_PANE detects tmux", () => {
    const out = detectLaunchEnvironment({ TMUX_PANE: "%2" });
    expect(out).toEqual({ mode: "tmux", terminalApp: "", source: "auto" });
  });

  test("UFOO_HOST_SESSION_ID detects host", () => {
    const out = detectLaunchEnvironment({ UFOO_HOST_SESSION_ID: "host-123" });
    expect(out).toEqual({ mode: "host", terminalApp: "", source: "auto" });
  });

  test("tmux beats host when both signals are present", () => {
    const out = detectLaunchEnvironment({
      TMUX_PANE: "%0",
      UFOO_HOST_SESSION_ID: "host-123",
    });
    expect(out.mode).toBe("tmux");
  });

  test("host beats native terminal when both signals are present", () => {
    const out = detectLaunchEnvironment({
      UFOO_HOST_SESSION_ID: "host-123",
      TERM_PROGRAM: "Apple_Terminal",
    });
    expect(out.mode).toBe("host");
  });

  test("Apple_Terminal sets terminalApp hint", () => {
    const out = detectLaunchEnvironment({ TERM_PROGRAM: "Apple_Terminal" });
    expect(out).toEqual({
      mode: "terminal",
      terminalApp: "Apple_Terminal",
      source: "auto",
    });
  });

  test("iTerm.app TERM_PROGRAM sets iterm2 hint", () => {
    const out = detectLaunchEnvironment({ TERM_PROGRAM: "iTerm.app" });
    expect(out.terminalApp).toBe("iterm2");
  });

  test("ITERM_SESSION_ID alone sets iterm2 hint", () => {
    const out = detectLaunchEnvironment({ ITERM_SESSION_ID: "w0t0p0" });
    expect(out).toEqual({
      mode: "terminal",
      terminalApp: "iterm2",
      source: "auto",
    });
  });

  test("falls back to terminal with empty hint when nothing matches", () => {
    const out = detectLaunchEnvironment({});
    expect(out).toEqual({ mode: "terminal", terminalApp: "", source: "auto" });
  });

  test("uses process.env when no env arg is provided", () => {
    const previous = process.env.UFOO_LAUNCH_MODE;
    process.env.UFOO_LAUNCH_MODE = "host";
    try {
      expect(detectLaunchEnvironment().mode).toBe("host");
    } finally {
      if (previous === undefined) delete process.env.UFOO_LAUNCH_MODE;
      else process.env.UFOO_LAUNCH_MODE = previous;
    }
  });
});
