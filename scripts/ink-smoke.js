"use strict";

/**
 * Headless smoke test for the ink demo: mounts the component, lets it tick
 * once, then unmounts. Exits with non-zero on any error. Used to confirm
 * the CJS->ESM bridge and component tree work without occupying the TTY.
 */

const { runInk } = require("../src/ui/runInk");
const { createInkDemo } = require("../src/ui/components/InkDemo");

(async () => {
  const handle = await runInk((React, ink) => {
    const InkDemo = createInkDemo({ React, ink, interactive: false });
    return React.createElement(InkDemo);
  }, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    exitOnCtrlC: false,
  });
  await new Promise((r) => setTimeout(r, 100));
  handle.unmount();
  await handle.waitUntilExit().catch(() => undefined);
  process.stdout.write("\nink-smoke: ok\n");
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`ink-smoke: failed: ${err && err.stack || err}\n`);
  process.exit(1);
});
