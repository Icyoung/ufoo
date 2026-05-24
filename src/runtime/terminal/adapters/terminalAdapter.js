const { createTerminalCapabilities } = require("../adapterContract");

function createTerminalAdapter(options = {}) {
  const {
    agentId = "",
    activateAgent = () => {},
    createAdapter = () => {},
  } = options;

  const capabilities = createTerminalCapabilities({
    supportsActivate: true,
    supportsReplay: true,
    supportsWindowClose: true,
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
  createTerminalAdapter,
};
