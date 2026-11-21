#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Sidecar entrypoint spawned by `crates/ufoo-desktop` (Tauri v2).
 *
 * Expects:
 *   --ui-socket <path>
 *   --project <optional-initial-project>
 *   UFOO_UI_TOKEN=<hex>
 */

const util = require("util");

// Redirect incidental console.log from init/bootstrap helpers to stderr so
// stdout remains a clean structured control stream for the Tauri supervisor.
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...args) => {
  process.stderr.write(`${util.format(...args)}\n`);
};

const { startDesktopUiHost } = require("./desktopUiHost");

function parseArg(flag, argv = process.argv.slice(2)) {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return "";
}

async function main() {
  const socketPath = parseArg("--ui-socket") || process.env.UFOO_UI_SOCKET || "";
  const initialProjectRoot = parseArg("--project") || process.env.UFOO_DESKTOP_PROJECT || "";
  const authToken = process.env.UFOO_UI_TOKEN || "";

  const handle = await startDesktopUiHost({
    socketPath: socketPath || undefined,
    authToken: authToken || undefined,
    initialProjectRoot: initialProjectRoot || undefined,
  });

  // Emit structured readiness line on stdout for the Tauri Rust supervisor
  rawStdoutWrite(`${JSON.stringify({
    ready: true,
    socketPath: handle.socketPath,
    handoffSocketPath: handle.handoffSocketPath,
  })}\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handle.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}

main().catch((err) => {
  console.error(`[desktop-ui-host] fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
