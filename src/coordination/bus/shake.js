/**
 * Terminal notification - sends visual alert to a terminal by TTY path.
 *
 * Supports:
 * - iTerm2: OSC 9 notification (native macOS notification)
 * - All terminals: terminal bell (\x07)
 */

const fs = require("fs");
const { isITerm2 } = require("../../runtime/terminal/detect");

function shakeTerminalByTty(ttyPath, options = {}) {
  if (!ttyPath) return false;

  try {
    const fd = fs.openSync(ttyPath, "w");
    // Terminal bell works universally
    fs.writeSync(fd, "\x07");
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

module.exports = { shakeTerminalByTty };
