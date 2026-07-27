"use strict";

/**
 * Stdin restore helpers after any fullscreen handoff (e.g. legacy multi).
 * Agent PTY mirror handoff has been removed — activate / side / multi only.
 */

function restoreStdinAfterHandoff(stdin = process.stdin) {
  try {
    if (stdin && typeof stdin.setRawMode === "function" && stdin.isTTY) {
      stdin.setRawMode(false);
    }
    if (stdin && typeof stdin.resume === "function") {
      stdin.resume();
    }
  } catch {
    // ignore — next TUI will reconfigure
  }
}

module.exports = {
  restoreStdinAfterHandoff,
};
