const { createTerminalCapabilities } = require("../adapterContract");

function createTmuxAdapter(options = {}) {
  const {
    agentId = "",
    activateAgent = () => {},
    createAdapter = () => {},
  } = options;

  const capabilities = createTerminalCapabilities({
    supportsActivate: true,
    supportsReplay: false,
    supportsNotifierInjector: true,
    supportsSessionReuse: true,
  });

  return createAdapter({
    capabilities,
    handlers: {
      activate: () => {
        activateAgent(agentId);
        return true;
      },
    },
  });
}

module.exports = {
  createTmuxAdapter,
};
