"use strict";

/**
 * Raw PTY passthrough for the internal-agent view.
 *
 * Ink can't usefully render arbitrary ANSI inside a Box (it would lose
 * cursor positioning, scroll regions and curses-style redraws), so this
 * helper takes over stdout/stdin while the user is "inside" an agent.
 * The strategy mirrors the blessed implementation:
 *   - clear the screen, set a scroll region with a 1-line bottom bar
 *   - stream agentSockets data straight to process.stdout
 *   - forward raw stdin bytes to agentSockets.sendRaw
 *   - on Esc, run the cleanup callback and let ChatApp re-render
 *
 * Returns a stop() function that the caller invokes on exit.
 */

const { createAgentSockets } = require("../../chat/agentSockets");
const { getUfooPaths } = require("../../ufoo/paths");
const path = require("path");

function startAgentMirror({
  agentId,
  projectRoot,
  onExit = () => {},
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!agentId) throw new Error("startAgentMirror requires agentId");

  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;

  // Mirror the lookup that runChatBlessed uses:
  // <bus-queues-dir>/<safeName>/inject.sock. We sanitise the agent id the
  // same way so a daemon launched by either TUI is reachable from the
  // other.
  const safeName = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "_");
  const sockPath = path.join(
    getUfooPaths(projectRoot || process.cwd()).busQueuesDir,
    safeName,
    "inject.sock"
  );

  const writeOut = (text) => stdout.write(text);

  const sockets = createAgentSockets({
    onTermWrite: (text) => writeOut(text),
    onPlaceCursor: (cursor) => {
      if (!cursor) return;
      const row = Math.max(1, (cursor.row || 0) + 1);
      const col = Math.max(1, (cursor.col || 0) + 1);
      writeOut(`\x1b[${row};${col}H`);
    },
    isAgentView: () => true,
    isBusMode: () => false,
    getViewingAgent: () => agentId,
    sendBusRaw: () => {},
  });

  // Clear screen + reserve a 1-line bar at the bottom for our exit hint.
  writeOut("\x1b[2J\x1b[H");
  writeOut(`\x1b[1;${Math.max(1, rows - 1)}r`);
  writeOut(`\x1b[${rows};1H\x1b[7m esc \x1b[0m return to chat · attached to ${agentId}`);
  writeOut("\x1b[H");

  sockets.connectOutput(sockPath);
  sockets.connectInput(sockPath);
  sockets.sendResize(cols, Math.max(1, rows - 1));

  let stopped = false;
  const wasRaw = Boolean(stdin.isRaw);
  if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
  stdin.resume();

  const onData = (chunk) => {
    if (stopped) return;
    // Esc on its own (single 0x1b byte, no follow-up) exits the mirror.
    // We can't perfectly distinguish a bare Esc from the start of an
    // arrow-key sequence; the convention here is "Esc + nothing within
    // 50ms means leave". Anything else gets forwarded as-is.
    if (chunk.length === 1 && chunk[0] === 0x1b) {
      setTimeout(() => {
        if (!stopped && pendingEsc === chunk) stop();
      }, 50);
      pendingEsc = chunk;
      return;
    }
    pendingEsc = null;
    sockets.sendRaw(chunk);
  };
  let pendingEsc = null;

  const onResize = () => {
    if (stopped) return;
    const cols2 = stdout.columns || 80;
    const rows2 = stdout.rows || 24;
    writeOut(`\x1b[1;${Math.max(1, rows2 - 1)}r`);
    sockets.sendResize(cols2, Math.max(1, rows2 - 1));
  };

  stdin.on("data", onData);
  stdout.on && stdout.on("resize", onResize);

  function stop() {
    if (stopped) return;
    stopped = true;
    stdin.off("data", onData);
    if (stdout.off) stdout.off("resize", onResize);
    sockets.disconnectOutput();
    sockets.disconnectInput();
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
    // Reset scroll region + clear screen so the next ink mount has a
    // clean canvas.
    writeOut(`\x1b[1;${stdout.rows || 24}r`);
    writeOut("\x1b[2J\x1b[H");
    onExit();
  }

  return stop;
}

module.exports = { startAgentMirror };
