const {
  TERMINAL_CAPABILITY_KEYS,
  TERMINAL_ADAPTER_METHODS,
  createTerminalCapabilities,
  assertTerminalCapabilities,
  createUnsupportedCapabilityError,
  requireCapability,
  assertTerminalAdapterContract,
} = require('../../../src/runtime/terminal/adapterContract');

describe('terminal/adapterContract', () => {
  test('createTerminalCapabilities returns full contract with overrides', () => {
    const caps = createTerminalCapabilities({ supportsActivate: true });
    expect(Object.keys(caps).sort()).toEqual([...TERMINAL_CAPABILITY_KEYS].sort());
    expect(caps.supportsActivate).toBe(true);
    expect(caps.supportsSnapshot).toBe(false);
  });

  test('assertTerminalCapabilities throws on missing or invalid fields', () => {
    expect(() => assertTerminalCapabilities({ supportsActivate: true })).toThrow(
      'TerminalAdapter capabilities missing: supportsSubscribeFull'
    );
    const bad = createTerminalCapabilities({ supportsActivate: 'yes' });
    expect(() => assertTerminalCapabilities(bad)).toThrow(
      'TerminalAdapter capability must be boolean: supportsActivate'
    );
  });

  test('requireCapability returns true for supported capability', () => {
    const caps = createTerminalCapabilities({ supportsActivate: true });
    expect(requireCapability(caps, 'supportsActivate', 'activate')).toBe(true);
  });

  test('requireCapability throws a consistent unsupported error', () => {
    const caps = createTerminalCapabilities();
    try {
      requireCapability(caps, 'supportsSnapshot', 'snapshot');
      throw new Error('expected requireCapability to throw');
    } catch (err) {
      expect(err.code).toBe('UFOO_UNSUPPORTED_CAPABILITY');
      expect(err.capability).toBe('supportsSnapshot');
      expect(err.operation).toBe('snapshot');
      expect(err.message).toBe('TerminalAdapter capability unsupported: supportsSnapshot (operation: snapshot)');
    }

    const plain = createUnsupportedCapabilityError('supportsReplay');
    expect(plain.code).toBe('UFOO_UNSUPPORTED_CAPABILITY');
    expect(plain.operation).toBe(null);
  });

  test('assertTerminalAdapterContract validates required methods and capabilities', () => {
    const adapter = {
      capabilities: createTerminalCapabilities(),
    };
    for (const method of TERMINAL_ADAPTER_METHODS) {
      adapter[method] = jest.fn();
    }
    expect(assertTerminalAdapterContract(adapter)).toBe(true);

    const broken = { ...adapter, send: null };
    expect(() => assertTerminalAdapterContract(broken)).toThrow('TerminalAdapter missing method: send');
  });
});
