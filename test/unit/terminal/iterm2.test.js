const { resetCache } = require('../../../src/runtime/terminal/detect');

describe('terminal/iterm2', () => {
  const originalEnv = { ...process.env };
  const originalStdout = process.stdout;
  let written;
  let mockStdout;

  beforeEach(() => {
    resetCache();
    written = [];

    // Set iTerm2 environment
    process.env.TERM_PROGRAM = 'iTerm.app';
    process.env.TERM_PROGRAM_VERSION = '3.5.0';

    // Mock stdout
    mockStdout = {
      isTTY: true,
      write: (data) => { written.push(data); return true; },
      columns: 80,
      rows: 24,
    };
    Object.defineProperty(process, 'stdout', {
      value: mockStdout,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.defineProperty(process, 'stdout', {
      value: originalStdout,
      writable: true,
      configurable: true,
    });
    resetCache();
    // Re-require to reset module state
    jest.resetModules();
  });

  // Re-require after env setup to get fresh detection
  function loadIterm2() {
    return require('../../../src/runtime/terminal/iterm2');
  }

  describe('setCwd()', () => {
    test('writes OSC 1337 CurrentDir sequence', () => {
      const iterm2 = loadIterm2();
      iterm2.setCwd('/Users/test/project');
      expect(written).toHaveLength(1);
      expect(written[0]).toBe('\x1b]1337;CurrentDir=/Users/test/project\x07');
    });

    test('no-ops with empty cwd', () => {
      const iterm2 = loadIterm2();
      iterm2.setCwd('');
      expect(written).toHaveLength(0);
    });
  });

  describe('setBadge()', () => {
    test('writes base64-encoded badge', () => {
      const iterm2 = loadIterm2();
      iterm2.setBadge('dev');
      expect(written).toHaveLength(1);
      const encoded = Buffer.from('dev').toString('base64');
      expect(written[0]).toBe(`\x1b]1337;SetBadgeFormat=${encoded}\x07`);
    });
  });

  describe('clearBadge()', () => {
    test('writes empty badge format', () => {
      const iterm2 = loadIterm2();
      iterm2.clearBadge();
      expect(written).toHaveLength(1);
      expect(written[0]).toBe('\x1b]1337;SetBadgeFormat=\x07');
    });
  });

  describe('notify()', () => {
    test('writes OSC 9 notification', () => {
      const iterm2 = loadIterm2();
      iterm2.notify('Hello agent');
      expect(written).toHaveLength(1);
      expect(written[0]).toBe('\x1b]9;Hello agent\x07');
    });

    test('no-ops with empty message', () => {
      const iterm2 = loadIterm2();
      iterm2.notify('');
      expect(written).toHaveLength(0);
    });
  });

  describe('promptMark()', () => {
    test('writes valid marks', () => {
      const iterm2 = loadIterm2();
      iterm2.promptMark('A');
      iterm2.promptMark('B');
      iterm2.promptMark('C');
      iterm2.promptMark('D');
      expect(written).toHaveLength(4);
      expect(written[0]).toBe('\x1b]133;A\x07');
      expect(written[3]).toBe('\x1b]133;D\x07');
    });

    test('ignores invalid mark codes', () => {
      const iterm2 = loadIterm2();
      iterm2.promptMark('X');
      expect(written).toHaveLength(0);
    });
  });

  describe('setCursorShape()', () => {
    test('writes cursor shape 0 (block)', () => {
      const iterm2 = loadIterm2();
      iterm2.setCursorShape(0);
      expect(written).toHaveLength(1);
      expect(written[0]).toBe('\x1b]1337;CursorShape=0\x07');
    });

    test('writes cursor shape 1 (bar)', () => {
      const iterm2 = loadIterm2();
      iterm2.setCursorShape(1);
      expect(written[0]).toBe('\x1b]1337;CursorShape=1\x07');
    });

    test('ignores invalid shapes', () => {
      const iterm2 = loadIterm2();
      iterm2.setCursorShape(5);
      expect(written).toHaveLength(0);
    });
  });

  describe('setTabColor()', () => {
    test('writes RGB tab color', () => {
      const iterm2 = loadIterm2();
      iterm2.setTabColor(255, 128, 0);
      expect(written).toHaveLength(3);
      expect(written[0]).toContain('red;brightness;255');
      expect(written[1]).toContain('green;brightness;128');
      expect(written[2]).toContain('blue;brightness;0');
    });

    test('resets tab color with null', () => {
      const iterm2 = loadIterm2();
      iterm2.setTabColor(null);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('default');
    });
  });

  describe('guard: non-iTerm2 environment', () => {
    test('all functions no-op when not iTerm2', () => {
      resetCache();
      delete process.env.TERM_PROGRAM;
      delete process.env.ITERM_SESSION_ID;
      jest.resetModules();
      const iterm2 = require('../../../src/runtime/terminal/iterm2');

      iterm2.setCwd('/test');
      iterm2.setBadge('test');
      iterm2.clearBadge();
      iterm2.notify('test');
      iterm2.promptMark('A');
      iterm2.setCursorShape(0);
      iterm2.setTabColor(0, 0, 0);

      expect(written).toHaveLength(0);
    });
  });

  describe('guard: non-TTY stdout', () => {
    test('all functions no-op when stdout is not a TTY', () => {
      mockStdout.isTTY = false;
      const iterm2 = loadIterm2();

      iterm2.setCwd('/test');
      iterm2.setBadge('test');
      iterm2.notify('test');

      expect(written).toHaveLength(0);
    });
  });

  describe('reportCwd()', () => {
    test('writes OSC 7 semantic URL (works in any terminal)', () => {
      // reportCwd does NOT check isITerm2, works universally
      resetCache();
      delete process.env.TERM_PROGRAM;
      jest.resetModules();
      const iterm2 = require('../../../src/runtime/terminal/iterm2');

      iterm2.reportCwd('/Users/test');
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^\x1b\]7;file:\/\/.+\/Users\/test\x07$/);
    });
  });
});
