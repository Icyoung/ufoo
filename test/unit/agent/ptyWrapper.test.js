const fs = require('fs');
const os = require('os');
const path = require('path');
const PtyWrapper = require('../../../src/agents/launch/ptyWrapper');

describe('PtyWrapper', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('imports and instantiates with expected defaults', () => {
    expect(typeof PtyWrapper).toBe('function');

    const wrapper = new PtyWrapper('echo', ['test'], { cwd: testDir });
    expect(wrapper.command).toBe('echo');
    expect(wrapper.args).toEqual(['test']);
    expect(wrapper.pty).toBeNull();
    expect(wrapper._cleaned).toBe(false);
  });

  test('serializes UTF-8 text as utf8', () => {
    const wrapper = new PtyWrapper('echo', ['test']);

    const ascii = wrapper._serializeData('Hello World');
    expect(ascii).toEqual({
      text: 'Hello World',
      encoding: 'utf8',
      size: 11,
    });

    const chinese = wrapper._serializeData('你好世界');
    expect(chinese.text).toBe('你好世界');
    expect(chinese.encoding).toBe('utf8');
    expect(chinese.size).toBeGreaterThan(0);
  });

  test('serializes binary payloads as base64', () => {
    const wrapper = new PtyWrapper('echo', ['test']);
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x01]);

    const result = wrapper._serializeData(invalidUtf8);
    expect(result.encoding).toBe('base64');
    expect(result.size).toBe(4);

    const decoded = Buffer.from(result.text, 'base64');
    expect(decoded.equals(invalidUtf8)).toBe(true);
  });

  test('enables logging and rejects duplicate enable', () => {
    const wrapper = new PtyWrapper('echo', ['test']);
    const logFile = path.join(testDir, 'test.jsonl');

    wrapper.enableLogging(logFile);
    expect(wrapper.logger).toBeTruthy();

    expect(() => wrapper.enableLogging(logFile)).toThrow(/already enabled/);

    wrapper.cleanup();
    expect(wrapper.logger).toBeNull();
  });

  test('enableMonitoring sets monitor callback', () => {
    const wrapper = new PtyWrapper('echo', ['test']);

    const onOutput = jest.fn();
    wrapper.enableMonitoring(onOutput);

    expect(wrapper.monitor).toBeTruthy();
    expect(typeof wrapper.monitor.onOutput).toBe('function');
  });

  test('cleanup is idempotent', () => {
    const wrapper = new PtyWrapper('echo', ['test']);
    const logFile = path.join(testDir, 'test2.jsonl');

    wrapper.enableLogging(logFile);

    wrapper.cleanup();
    expect(wrapper._cleaned).toBe(true);
    expect(wrapper.logger).toBeNull();

    expect(() => wrapper.cleanup()).not.toThrow();
    expect(wrapper._cleaned).toBe(true);
  });

  test('prepends host nickname prefix to OSC title updates', () => {
    const wrapper = new PtyWrapper('echo', ['test'], { titlePrefix: 'builder' });

    expect(wrapper._prependTitlePrefix('\x1b]0;Claude Code\x07')).toBe('\x1b]0;builder:Claude Code\x07');
    expect(wrapper._prependTitlePrefix('\x1b]2;builder:Code X\x07')).toBe('\x1b]2;builder:Code X\x07');
    expect(wrapper._prependTitlePrefix('plain output')).toBe('plain output');
  });

  test('handles split OSC title updates before prepending host prefix', () => {
    const wrapper = new PtyWrapper('echo', ['test'], { titlePrefix: 'reviewer' });

    expect(wrapper._prependTitlePrefix('\x1b]0;Claude')).toBe('');
    expect(wrapper._prependTitlePrefix(' Code\x07ready')).toBe('\x1b]0;reviewer:Claude Code\x07ready');
  });
});
