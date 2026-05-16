"use strict";

/**
 * Detect the launch environment for a ufoo agent.
 *
 * Output is the canonical `mode` plus an optional `terminalApp` hint when the
 * mode is `terminal` (used by the inject layer to pick AppleScript flavor).
 *
 * Detection rules, evaluated top-to-bottom (first match wins):
 *
 *   0. `UFOO_LAUNCH_MODE` is a non-`auto` canonical value → trust it (short-circuit).
 *   1. `TMUX_PANE` is set                                 → tmux.
 *   2. `UFOO_HOST_SESSION_ID` is set                      → host.
 *   3. `TERM_PROGRAM === "Apple_Terminal"`                → terminal / Apple_Terminal.
 *   4. `TERM_PROGRAM === "iTerm.app"` or `ITERM_SESSION_ID` set → terminal / iterm2.
 *   5. Fallback                                            → terminal (no app hint).
 *
 * Host is detected by env var alone here; callers that want to override host
 * with native-terminal evidence (e.g. daemon ops auto-resolution) layer that
 * on top of the detector's output.
 * Internal / internal-pty modes are always set explicitly by the daemon when
 * spawning worker processes (see ptyRunner / daemon ops), so they fall through
 * the explicit short-circuit and never need to be auto-detected here.
 */

const CANONICAL_LAUNCH_MODES = Object.freeze([
  "terminal",
  "tmux",
  "host",
  "internal",
  "internal-pty",
]);

const CANONICAL_LAUNCH_MODE_SET = new Set(CANONICAL_LAUNCH_MODES);

function detectLaunchEnvironment(env = process.env) {
  const explicit = String(env.UFOO_LAUNCH_MODE || "").trim();
  if (explicit && explicit !== "auto" && CANONICAL_LAUNCH_MODE_SET.has(explicit)) {
    return { mode: explicit, terminalApp: "", source: "explicit" };
  }

  if (env.TMUX_PANE) {
    return { mode: "tmux", terminalApp: "", source: "auto" };
  }

  if (env.UFOO_HOST_SESSION_ID) {
    return { mode: "host", terminalApp: "", source: "auto" };
  }

  const termProgram = String(env.TERM_PROGRAM || "").trim();
  if (termProgram === "Apple_Terminal") {
    return { mode: "terminal", terminalApp: "Apple_Terminal", source: "auto" };
  }
  if (termProgram === "iTerm.app" || env.ITERM_SESSION_ID) {
    return { mode: "terminal", terminalApp: "iterm2", source: "auto" };
  }

  return { mode: "terminal", terminalApp: "", source: "auto" };
}

module.exports = {
  detectLaunchEnvironment,
  CANONICAL_LAUNCH_MODES,
};
