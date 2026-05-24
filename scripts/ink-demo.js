#!/usr/bin/env node
"use strict";

/**
 * Interactive ink demo. Run from a real TTY:
 *   npm run ink:demo
 * or
 *   node scripts/ink-demo.js
 */

const { runInk } = require("../src/ui/runInk");
const { createInkDemo } = require("../src/ui/ink/InkDemo");

(async () => {
  const handle = await runInk((React, ink) => {
    const InkDemo = createInkDemo({ React, ink, interactive: true });
    return React.createElement(InkDemo);
  });
  await handle.waitUntilExit();
})().catch((err) => {
  process.stderr.write(`ink-demo: ${err && err.stack || err}\n`);
  process.exit(1);
});
