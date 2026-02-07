const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadTokens,
  saveTokens,
  setToken,
  removeToken,
  getToken,
  listTokens,
  generateToken,
  hashToken,
} = require('../../../src/online/tokens');

describe('online tokens', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-online-'));
    file = path.join(dir, 'tokens.json');
  });

  test('set and get token', () => {
    setToken(file, 'claude-code:abc', 'tok-1', 'wss://example');
    const entry = getToken(file, 'claude-code:abc');
    expect(entry.token).toBe('tok-1');
    expect(entry.server).toBe('wss://example');
  });

  test('remove token', () => {
    setToken(file, 'codex:def', 'tok-2', 'wss://example');
    removeToken(file, 'codex:def');
    expect(getToken(file, 'codex:def')).toBe(null);
  });

  test('list tokens', () => {
    setToken(file, 'a', 't1', 's1');
    setToken(file, 'b', 't2', 's2');
    const list = listTokens(file);
    expect(list.length).toBe(2);
  });

  test('generate + hash token', () => {
    const token = generateToken(16);
    const hashed = hashToken(token);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(hashed).toHaveLength(64);
  });

  test('load legacy flat object', () => {
    saveTokens(file, { foo: { token: 'x' } });
    const data = loadTokens(file);
    expect(data.agents.foo.token).toBe('x');
  });
});
