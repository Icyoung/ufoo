/**
 * iTerm2-specific terminal features via OSC escape sequences.
 *
 * All functions are guarded — they no-op when not running in iTerm2
 * or when stdout is not a TTY.
 *
 * References:
 *   https://iterm2.com/documentation-escape-codes.html
 */

const { isITerm2 } = require("./detect");

const ESC = "\x1b";
const BEL = "\x07";
const OSC = `${ESC}]`;

function canWrite() {
  return isITerm2() && process.stdout && process.stdout.isTTY;
}

/**
 * Notify iTerm2 of the current working directory (OSC 1337).
 * Enables the Shell Integration "Recent Directories" feature and
 * makes "Open in Finder" point to the correct location.
 */
function setCwd(cwd) {
  if (!canWrite() || !cwd) return;
  process.stdout.write(`${OSC}1337;CurrentDir=${cwd}${BEL}`);
}

/**
 * Set a user-defined badge in the upper-right of the session.
 * Supports iTerm2 interpolated-string variables like \(session.name).
 */
function setBadge(text) {
  if (!canWrite()) return;
  const encoded = Buffer.from(text || "").toString("base64");
  process.stdout.write(`${OSC}1337;SetBadgeFormat=${encoded}${BEL}`);
}

/**
 * Clear the session badge.
 */
function clearBadge() {
  if (!canWrite()) return;
  process.stdout.write(`${OSC}1337;SetBadgeFormat=${BEL}`);
}

/**
 * Post a macOS notification through iTerm2 (OSC 9).
 * Only fires when the session tab is NOT focused, so it
 * naturally avoids spamming the user.
 */
function notify(message) {
  if (!canWrite() || !message) return;
  process.stdout.write(`${OSC}9;${message}${BEL}`);
}

/**
 * Emit a shell-integration prompt mark (OSC 133).
 *  A = start of prompt   B = end of prompt / start of command
 *  C = start of output   D = end of output (with exit status)
 */
function promptMark(code) {
  if (!canWrite()) return;
  const valid = ["A", "B", "C", "D"];
  if (!valid.includes(code)) return;
  process.stdout.write(`${OSC}133;${code}${BEL}`);
}

/**
 * Set cursor shape.
 *  0 = block  1 = vertical bar  2 = underline
 */
function setCursorShape(shape) {
  if (!canWrite()) return;
  if (![0, 1, 2].includes(shape)) return;
  process.stdout.write(`${OSC}1337;CursorShape=${shape}${BEL}`);
}

/**
 * Set the tab color for this session (RGB).
 * Pass null/undefined to reset to default.
 */
function setTabColor(r, g, b) {
  if (!canWrite()) return;
  if (r == null) {
    // reset
    process.stdout.write(`${OSC}6;1;bg;*;default${BEL}`);
    return;
  }
  process.stdout.write(`${OSC}6;1;bg;red;brightness;${r}${BEL}`);
  process.stdout.write(`${OSC}6;1;bg;green;brightness;${g}${BEL}`);
  process.stdout.write(`${OSC}6;1;bg;blue;brightness;${b}${BEL}`);
}

/**
 * Add an annotation at the current cursor position.
 */
function annotation(message) {
  if (!canWrite() || !message) return;
  const len = message.length;
  process.stdout.write(`${OSC}1337;AddAnnotation=${len}|${message}${BEL}`);
}

/**
 * Report current directory using OSC 7 (semantic URL).
 * Understood by iTerm2, Terminal.app, and VTE-based terminals.
 */
function reportCwd(cwd) {
  if (!process.stdout || !process.stdout.isTTY || !cwd) return;
  const hostname = require("os").hostname();
  process.stdout.write(`${OSC}7;file://${hostname}${cwd}${BEL}`);
}

module.exports = {
  setCwd,
  setBadge,
  clearBadge,
  notify,
  promptMark,
  setCursorShape,
  setTabColor,
  annotation,
  reportCwd,
};
