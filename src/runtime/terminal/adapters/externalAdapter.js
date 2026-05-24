const { createTerminalAdapter } = require("./terminalAdapter");
const { createTmuxAdapter } = require("./tmuxAdapter");

function createExternalAdapter(options = {}) {
  const mode = options.mode || "terminal";
  if (mode === "tmux") {
    return createTmuxAdapter(options);
  }
  return createTerminalAdapter(options);
}

module.exports = {
  createExternalAdapter,
};
