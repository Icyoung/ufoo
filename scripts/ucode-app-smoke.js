"use strict";

/**
 * Headless mount test for the UcodeApp shell. Boots the ink TUI with stub
 * runner props, lets it render once, then unmounts. Used to confirm the ink
 * code path stays compilable as P1 evolves.
 */

const { runInk } = require("../src/ui/runInk");
const { createUcodeApp } = require("../src/ui/ink/UcodeApp");

(async () => {
  const props = {
    stdin: process.stdin,
    stdout: process.stdout,
    runSingleCommand: () => ({ kind: "empty" }),
    runNaturalLanguageTask: async () => ({ ok: true, summary: "ok" }),
    runUbusCommand: async () => ({ ok: false, error: "ubus unsupported", summary: "" }),
    formatNlResult: () => "ok",
    workspaceRoot: process.cwd(),
    state: { model: "test-model", sessionId: "smoke", engine: "ufoo-core" },
    autoBus: { enabled: false, getPendingCount: () => 0, subscriberId: "" },
  };
  const handle = await runInk((React, ink) => {
    const UcodeApp = createUcodeApp({ React, ink, props, interactive: false });
    return React.createElement(UcodeApp);
  }, { stdout: process.stdout, stderr: process.stderr });
  await new Promise((r) => setTimeout(r, 80));
  handle.unmount();
  await handle.waitUntilExit().catch(() => undefined);
  process.stdout.write("\nucode-app-smoke: ok\n");
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`ucode-app-smoke: failed: ${err && err.stack || err}\n`);
  process.exit(1);
});
