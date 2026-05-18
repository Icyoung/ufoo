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

async function runInk(createRoot, options = {}) {
  const ink = await import("ink");
  const React = require("react");
  const element = createRoot(React, ink);
  if (!element) throw new Error("runInk: createRoot returned no element");
  const inst = ink.render(element, {
    stdin: options.stdin || process.stdin,
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
    exitOnCtrlC: options.exitOnCtrlC !== false,
    patchConsole: options.patchConsole === true,
  });
  return {
    waitUntilExit: () => inst.waitUntilExit(),
    rerender: (next) => inst.rerender(next),
    unmount: () => inst.unmount(),
    cleanup: () => inst.cleanup(),
    instance: inst,
    React,
    ink,
  };
}

module.exports = { runInk };
