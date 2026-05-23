async function runChat(projectRoot, options = {}) {
  const { runChatInk } = require("../ui/components/ChatApp");
  return runChatInk(projectRoot, options);
}

module.exports = { runChat };
