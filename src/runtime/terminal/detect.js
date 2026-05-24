/**
 * Terminal type detection
 *
 * Detects the terminal emulator and its capabilities from environment variables.
 * Results are cached for the lifetime of the process.
 */

const TERMINAL_TYPES = {
  ITERM2: "iterm2",
  APPLE_TERMINAL: "apple-terminal",
  KITTY: "kitty",
  WEZTERM: "wezterm",
  ALACRITTY: "alacritty",
  UNKNOWN: "unknown",
};

let cached = null;

/**
 * Detect the current terminal emulator.
 * @returns {{ type: string, version: string, truecolor: boolean }}
 */
function detect() {
  if (cached) return cached;

  const prog = process.env.TERM_PROGRAM || "";
  const ver = process.env.TERM_PROGRAM_VERSION || "";
  const colorterm = (process.env.COLORTERM || "").toLowerCase();
  const truecolor = colorterm === "truecolor" || colorterm === "24bit";

  let type = TERMINAL_TYPES.UNKNOWN;

  if (prog === "iTerm.app" || process.env.ITERM_SESSION_ID) {
    type = TERMINAL_TYPES.ITERM2;
  } else if (prog === "Apple_Terminal") {
    type = TERMINAL_TYPES.APPLE_TERMINAL;
  } else if (prog === "kitty" || process.env.KITTY_PID) {
    type = TERMINAL_TYPES.KITTY;
  } else if (prog === "WezTerm") {
    type = TERMINAL_TYPES.WEZTERM;
  } else if (prog === "Alacritty") {
    type = TERMINAL_TYPES.ALACRITTY;
  }

  cached = { type, version: ver, truecolor };
  return cached;
}

function isITerm2() {
  return detect().type === TERMINAL_TYPES.ITERM2;
}

function isAppleTerminal() {
  return detect().type === TERMINAL_TYPES.APPLE_TERMINAL;
}

/**
 * Reset cached detection (for testing).
 */
function resetCache() {
  cached = null;
}

module.exports = { detect, isITerm2, isAppleTerminal, resetCache, TERMINAL_TYPES };
