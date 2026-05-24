const TERMINAL_CAPABILITY_KEYS = [
  "supportsActivate",
  "supportsSubscribeFull",
  "supportsSubscribeScreen",
  "supportsSnapshot",
  "supportsReplay",
  "supportsWindowClose",
  "supportsSocketProtocol",
  "supportsNotifierInjector",
  "supportsInternalQueueLoop",
  "supportsRestartFallback",
  "supportsSessionReuse",
];

const TERMINAL_ADAPTER_METHODS = [
  "connect",
  "disconnect",
  "send",
  "sendRaw",
  "resize",
  "snapshot",
  "subscribe",
  "activate",
  "getState",
];

function createTerminalCapabilities(overrides = {}) {
  const capabilities = {};
  for (const key of TERMINAL_CAPABILITY_KEYS) {
    capabilities[key] = false;
  }
  return { ...capabilities, ...overrides };
}

function assertTerminalCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object") {
    throw new Error("TerminalAdapter capabilities must be an object");
  }
  for (const key of TERMINAL_CAPABILITY_KEYS) {
    if (!(key in capabilities)) {
      throw new Error(`TerminalAdapter capabilities missing: ${key}`);
    }
    if (typeof capabilities[key] !== "boolean") {
      throw new Error(`TerminalAdapter capability must be boolean: ${key}`);
    }
  }
  return true;
}

function createUnsupportedCapabilityError(capability, operation) {
  const suffix = operation ? ` (operation: ${operation})` : "";
  const err = new Error(`TerminalAdapter capability unsupported: ${capability}${suffix}`);
  err.code = "UFOO_UNSUPPORTED_CAPABILITY";
  err.capability = capability;
  err.operation = operation || null;
  return err;
}

function requireCapability(capabilities, capability, operation) {
  if (!capabilities || !capabilities[capability]) {
    throw createUnsupportedCapabilityError(capability, operation);
  }
  return true;
}

function assertTerminalAdapterContract(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("TerminalAdapter must be an object");
  }
  for (const method of TERMINAL_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`TerminalAdapter missing method: ${method}`);
    }
  }
  assertTerminalCapabilities(adapter.capabilities);
  return true;
}

module.exports = {
  TERMINAL_CAPABILITY_KEYS,
  TERMINAL_ADAPTER_METHODS,
  createTerminalCapabilities,
  assertTerminalCapabilities,
  createUnsupportedCapabilityError,
  requireCapability,
  assertTerminalAdapterContract,
};
