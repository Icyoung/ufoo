"use strict";

/**
 * Headless mount test for the ChatApp shell. Boots the ink TUI with stub
 * props (no daemon, no real bootstrap) and checks the component tree
 * renders without throwing. Used for CI parity with ucode-app-smoke.js.
 */

const { runInk } = require("../src/ui/runInk");
const { createChatApp } = require("../src/ui/ink/ChatApp");

(async () => {
  const props = {
    activeProjectRoot: process.cwd(),
    globalMode: false,
    globalScope: "project",
  };
  const handle = await runInk((React, ink) => {
    const ChatApp = createChatApp({ React, ink, props, interactive: false });
    return React.createElement(ChatApp);
  }, { stdout: process.stdout, stderr: process.stderr });
  await new Promise((r) => setTimeout(r, 80));
  handle.unmount();
  await handle.waitUntilExit().catch(() => undefined);
  process.stdout.write("\nchat-app-smoke: ok\n");
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`chat-app-smoke: failed: ${err && err.stack || err}\n`);
  process.exit(1);
});
