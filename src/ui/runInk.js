"use strict";

/**
 * Ink runtime launcher for ufoo TUIs.
 *
 * ufoo is CommonJS, ink@5 is ESM-only. We bridge by dynamic-importing ink
 * and exposing a CJS-friendly API that takes a `createRoot(React, ink)`
 * factory instead of a pre-built React element. The factory is invoked with
 * the loaded `React` module and ink namespace so callers don't need to
 * import them themselves.
 *
 * Usage:
 *   const { runInk } = require("./runInk");
 *   const handle = await runInk(
 *     (React, ink) => React.createElement(App, props),
 *     { stdin, stdout },
 *   );
 *   await handle.waitUntilExit();
 */

// Resolve the ink.render options. patchConsole defaults ON so stray
// console.log/warn output is routed through Ink (rendered above the live
// frame) instead of punching holes through the repainted frame — direct
// stdout writes mid-frame are a classic cause of visible flicker/tearing.
function resolveInkRenderOptions(options = {}) {
  return {
    stdin: options.stdin || process.stdin,
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
    exitOnCtrlC: options.exitOnCtrlC !== false,
    patchConsole: options.patchConsole !== false,
  };
}

async function runInk(createRoot, options = {}) {
  const ink = await import("ink");
  const React = require("react");
  const element = createRoot(React, ink);
  if (!element) throw new Error("runInk: createRoot returned no element");
  const renderOptions = resolveInkRenderOptions(options);
  const stdout = renderOptions.stdout;
  const inst = ink.render(element, renderOptions);
  // ink keeps the final rendered frame on screen when it unmounts (it writes
  // the frame as plain stdout output), which leaves the TUI lingering after
  // Ctrl+C. Clear and home the cursor on every clean exit so the shell prompt
  // returns to the top of a blank screen.
  const wrappedExit = inst.waitUntilExit().then((value) => {
    try {
      if (stdout && stdout.isTTY && typeof stdout.write === "function") {
        stdout.write("\x1b[2J\x1b[H");
      }
    } catch { /* ignore */ }
    return value;
  });
  return {
    waitUntilExit: () => wrappedExit,
    rerender: (next) => inst.rerender(next),
    unmount: () => inst.unmount(),
    cleanup: () => inst.cleanup(),
    instance: inst,
    React,
    ink,
  };
}

module.exports = { runInk, resolveInkRenderOptions };
