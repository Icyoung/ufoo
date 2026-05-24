const { detect, isITerm2, isAppleTerminal, resetCache, TERMINAL_TYPES } = require('../../../src/runtime/terminal/detect');

describe('terminal/detect', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetCache();
    // Clear terminal-related env vars
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM_PROGRAM_VERSION;
    delete process.env.ITERM_SESSION_ID;
    delete process.env.KITTY_PID;
    delete process.env.COLORTERM;
  });

  afterEach(() => {
    // Restore original env
    Object.assign(process.env, originalEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    resetCache();
  });

  describe('detect()', () => {
    test('detects iTerm2 via TERM_PROGRAM', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      process.env.TERM_PROGRAM_VERSION = '3.5.0';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.ITERM2);
      expect(result.version).toBe('3.5.0');
    });

    test('detects iTerm2 via ITERM_SESSION_ID', () => {
      process.env.ITERM_SESSION_ID = 'w0t0p0:ABCD';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.ITERM2);
    });

    test('detects Apple Terminal', () => {
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.APPLE_TERMINAL);
    });

    test('detects kitty via TERM_PROGRAM', () => {
      process.env.TERM_PROGRAM = 'kitty';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.KITTY);
    });

    test('detects kitty via KITTY_PID', () => {
      process.env.KITTY_PID = '12345';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.KITTY);
    });

    test('detects WezTerm', () => {
      process.env.TERM_PROGRAM = 'WezTerm';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.WEZTERM);
    });

    test('detects Alacritty', () => {
      process.env.TERM_PROGRAM = 'Alacritty';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.ALACRITTY);
    });

    test('returns unknown for unrecognized terminal', () => {
      process.env.TERM_PROGRAM = 'SomeOtherTerminal';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.UNKNOWN);
    });

    test('returns unknown when no env vars set', () => {
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.UNKNOWN);
    });

    test('detects truecolor support', () => {
      process.env.COLORTERM = 'truecolor';
      const result = detect();
      expect(result.truecolor).toBe(true);
    });

    test('detects 24bit as truecolor', () => {
      process.env.COLORTERM = '24bit';
      const result = detect();
      expect(result.truecolor).toBe(true);
    });

    test('no truecolor when COLORTERM is 256', () => {
      process.env.COLORTERM = '256';
      const result = detect();
      expect(result.truecolor).toBe(false);
    });

    test('caches result across calls', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      const first = detect();
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      const second = detect();
      expect(first).toBe(second);
      expect(second.type).toBe(TERMINAL_TYPES.ITERM2);
    });

    test('resetCache() clears cached result', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      detect();
      resetCache();
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      const result = detect();
      expect(result.type).toBe(TERMINAL_TYPES.APPLE_TERMINAL);
    });
  });

  describe('isITerm2()', () => {
    test('returns true when iTerm2', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      expect(isITerm2()).toBe(true);
    });

    test('returns false when not iTerm2', () => {
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      expect(isITerm2()).toBe(false);
    });
  });

  describe('isAppleTerminal()', () => {
    test('returns true when Apple Terminal', () => {
      process.env.TERM_PROGRAM = 'Apple_Terminal';
      expect(isAppleTerminal()).toBe(true);
    });

    test('returns false when not Apple Terminal', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      expect(isAppleTerminal()).toBe(false);
    });
  });
});
