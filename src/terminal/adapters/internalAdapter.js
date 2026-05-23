const { createInternalQueueAdapter } = require("./internalQueueAdapter");

function createInternalAdapter(options = {}) {
  return createInternalQueueAdapter(options);
}

module.exports = {
  createInternalAdapter,
};
