async function runChat(projectRoot, options = {}) {
  const { runChatInk } = require("../../ui/ink/ChatApp");
  return runChatInk(projectRoot, options);
}

module.exports = { runChat };
