const { createTerminalCapabilities } = require("../adapterContract");

function createInternalQueueAdapter(options = {}) {
  const {
    sendRaw = () => {},
    createAdapter = () => {},
  } = options;

  const capabilities = createTerminalCapabilities({
    supportsInternalQueueLoop: true,
    supportsSocketProtocol: false,
    supportsSubscribeFull: false,
    supportsSubscribeScreen: false,
    supportsSnapshot: false,
  });

  return createAdapter({
    capabilities,
    handlers: {
      send: (data) => {
        sendRaw(data);
        return true;
      },
      sendRaw: (data) => {
        sendRaw(data);
        return true;
      },
      resize: () => false,
      snapshot: () => false,
      subscribe: () => false,
    },
  });
}

module.exports = {
  createInternalQueueAdapter,
};
