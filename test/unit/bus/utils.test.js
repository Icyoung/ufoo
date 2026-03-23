const {
  getTimestamp,
  getDate,
  generateInstanceId,
  subscriberToSafeName,
  safeNameToSubscriber,
  isPidAlive,
  readJSON,
  writeJSON,
  readJSONL,
  appendJSONL,
  truncateFile,
  isValidTty,
  readLastLine,
  ensureDir,
  sleep,
  isMetaActive,
  normalizeAgentTypeAlias,
} = require('../../../src/bus/utils');
const fs = require('fs');
const path = require('path');

describe('Bus Utils', () => {
  const testDir = '/tmp/ufoo-utils-test';

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getTimestamp', () => {
    it('should return ISO 8601 timestamp', () => {
      const timestamp = getTimestamp();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return different timestamps when called multiple times', async () => {
      const ts1 = getTimestamp();
      await new Promise(resolve => setTimeout(resolve, 10));
      const ts2 = getTimestamp();
      expect(ts1).not.toBe(ts2);
    });
  });

  describe('getDate', () => {
    it('should return YYYY-MM-DD format', () => {
      const date = getDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should match timestamp date part', () => {
      const timestamp = getTimestamp();
      const date = getDate();
      expect(timestamp.startsWith(date)).toBe(true);
    });
  });

  describe('generateInstanceId', () => {
    it('should return 8-character hex string', () => {
      const id = generateInstanceId();
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateInstanceId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('subscriberToSafeName', () => {
    it('should replace colon with underscore', () => {
      expect(subscriberToSafeName('claude-code:abc123')).toBe('claude-code_abc123');
      expect(subscriberToSafeName('codex:xyz789')).toBe('codex_xyz789');
    });

    it('should handle multiple colons', () => {
      expect(subscriberToSafeName('test:foo:bar')).toBe('test_foo_bar');
    });
  });

  describe('safeNameToSubscriber', () => {
    it('should replace first underscore with colon', () => {
      expect(safeNameToSubscriber('claude-code_abc123')).toBe('claude-code:abc123');
      expect(safeNameToSubscriber('codex_xyz789')).toBe('codex:xyz789');
    });

    it('should only replace first underscore', () => {
      expect(safeNameToSubscriber('test_foo_bar')).toBe('test:foo_bar');
    });

    it('should return original if no underscore', () => {
      expect(safeNameToSubscriber('noUnderscore')).toBe('noUnderscore');
    });
  });

  describe('isPidAlive', () => {
    it('should return false for invalid PID', () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(null)).toBe(false);
      expect(isPidAlive(undefined)).toBe(false);
    });

    it('should return true for own PID', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('should return false for non-existent PID', () => {
      expect(isPidAlive(999999)).toBe(false);
    });
  });

  describe('JSON operations', () => {
    describe('readJSON', () => {
      it('should read valid JSON file', () => {
        const testFile = path.join(testDir, 'test.json');
        const data = { foo: 'bar', num: 42 };
        fs.writeFileSync(testFile, JSON.stringify(data), 'utf8');

        expect(readJSON(testFile)).toEqual(data);
      });

      it('should return default value for non-existent file', () => {
        const defaultValue = { default: true };
        expect(readJSON('/nonexistent.json', defaultValue)).toEqual(defaultValue);
      });

      it('should return default value for invalid JSON', () => {
        const testFile = path.join(testDir, 'invalid.json');
        fs.writeFileSync(testFile, 'not valid json', 'utf8');
        expect(readJSON(testFile, null)).toBeNull();
      });
    });

    describe('writeJSON', () => {
      it('should write formatted JSON', () => {
        const testFile = path.join(testDir, 'output.json');
        const data = { foo: 'bar', num: 42 };

        writeJSON(testFile, data);

        const content = fs.readFileSync(testFile, 'utf8');
        expect(JSON.parse(content)).toEqual(data);
        expect(content).toContain('\n'); // Should be formatted
      });

      it('should create parent directories', () => {
        const testFile = path.join(testDir, 'nested', 'dir', 'output.json');
        const data = { test: true };

        writeJSON(testFile, data);

        expect(fs.existsSync(testFile)).toBe(true);
        expect(readJSON(testFile)).toEqual(data);
      });
    });
  });

  describe('JSONL operations', () => {
    describe('readJSONL', () => {
      it('should read JSONL file', () => {
        const testFile = path.join(testDir, 'test.jsonl');
        const lines = [
          { id: 1, message: 'first' },
          { id: 2, message: 'second' },
          { id: 3, message: 'third' },
        ];

        fs.writeFileSync(
          testFile,
          lines.map(l => JSON.stringify(l)).join('\n'),
          'utf8'
        );

        expect(readJSONL(testFile)).toEqual(lines);
      });

      it('should return empty array for non-existent file', () => {
        expect(readJSONL('/nonexistent.jsonl')).toEqual([]);
      });

      it('should skip invalid lines', () => {
        const testFile = path.join(testDir, 'mixed.jsonl');
        fs.writeFileSync(
          testFile,
          '{"valid":true}\ninvalid line\n{"also":"valid"}',
          'utf8'
        );

        const result = readJSONL(testFile);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ valid: true });
        expect(result[1]).toEqual({ also: 'valid' });
      });
    });

    describe('appendJSONL', () => {
      it('should append to existing file', () => {
        const testFile = path.join(testDir, 'append.jsonl');

        appendJSONL(testFile, { id: 1 });
        appendJSONL(testFile, { id: 2 });
        appendJSONL(testFile, { id: 3 });

        const lines = readJSONL(testFile);
        expect(lines).toHaveLength(3);
        expect(lines[0].id).toBe(1);
        expect(lines[2].id).toBe(3);
      });

      it('should create file if not exists', () => {
        const testFile = path.join(testDir, 'new.jsonl');

        appendJSONL(testFile, { test: true });

        expect(fs.existsSync(testFile)).toBe(true);
        expect(readJSONL(testFile)).toEqual([{ test: true }]);
      });
    });

    describe('truncateFile', () => {
      it('should clear file content', () => {
        const testFile = path.join(testDir, 'truncate.txt');
        fs.writeFileSync(testFile, 'some content', 'utf8');

        truncateFile(testFile);

        expect(fs.readFileSync(testFile, 'utf8')).toBe('');
      });

      it('should not fail for non-existent file', () => {
        expect(() => truncateFile('/nonexistent.txt')).not.toThrow();
      });
    });
  });

  describe('isValidTty', () => {
    it('returns false for falsy input', () => {
      expect(isValidTty(null)).toBe(false);
      expect(isValidTty("")).toBe(false);
      expect(isValidTty(undefined)).toBe(false);
    });

    it('returns false for /dev/tty', () => {
      expect(isValidTty("/dev/tty")).toBe(false);
    });

    it('returns false for non-/dev/ paths', () => {
      expect(isValidTty("/tmp/tty")).toBe(false);
    });

    it('returns true for valid tty paths', () => {
      expect(isValidTty("/dev/ttys001")).toBe(true);
      expect(isValidTty("/dev/pts/1")).toBe(true);
    });
  });

  describe('readLastLine', () => {
    it('returns null for non-existent file', () => {
      expect(readLastLine('/nonexistent')).toBeNull();
    });

    it('returns null for empty file', () => {
      const file = path.join(testDir, 'empty.txt');
      fs.writeFileSync(file, '', 'utf8');
      expect(readLastLine(file)).toBeNull();
    });

    it('returns last line of file', () => {
      const file = path.join(testDir, 'lines.txt');
      fs.writeFileSync(file, 'line1\nline2\nline3', 'utf8');
      expect(readLastLine(file)).toBe('line3');
    });
  });

  describe('ensureDir', () => {
    it('creates directory if not exists', () => {
      const dir = path.join(testDir, 'new', 'nested');
      ensureDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('does not fail if directory exists', () => {
      ensureDir(testDir);
      expect(fs.existsSync(testDir)).toBe(true);
    });
  });

  describe('sleep', () => {
    it('resolves after delay', async () => {
      const start = Date.now();
      await sleep(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
  });

  describe('normalizeAgentTypeAlias', () => {
    it('normalizes codex', () => {
      expect(normalizeAgentTypeAlias("codex")).toBe("codex");
    });

    it('normalizes claude variants', () => {
      expect(normalizeAgentTypeAlias("claude")).toBe("claude-code");
      expect(normalizeAgentTypeAlias("claude-code")).toBe("claude-code");
    });

    it('normalizes ufoo variants', () => {
      expect(normalizeAgentTypeAlias("ufoo")).toBe("ufoo-code");
      expect(normalizeAgentTypeAlias("ucode")).toBe("ufoo-code");
      expect(normalizeAgentTypeAlias("ufoo-code")).toBe("ufoo-code");
    });

    it('returns empty for empty input', () => {
      expect(normalizeAgentTypeAlias("")).toBe("");
      expect(normalizeAgentTypeAlias(null)).toBe("");
    });

    it('returns lowercase for unknown types', () => {
      expect(normalizeAgentTypeAlias("custom")).toBe("custom");
    });
  });

  describe('isMetaActive', () => {
    it('returns false for null meta', () => {
      expect(isMetaActive(null)).toBe(false);
    });

    it('returns false for inactive status', () => {
      expect(isMetaActive({ status: "inactive" })).toBe(false);
    });

    it('returns true when pid is alive', () => {
      expect(isMetaActive({ status: "active", pid: process.pid })).toBe(true);
    });

    it('returns false when pid is dead', () => {
      expect(isMetaActive({ status: "active", pid: 999999 })).toBe(false);
    });

    it('uses heartbeat timeout for active status without pid', () => {
      expect(isMetaActive({
        status: "active",
        last_seen: new Date().toISOString(),
      })).toBe(true);

      expect(isMetaActive({
        status: "active",
        last_seen: new Date(Date.now() - 60000).toISOString(),
      })).toBe(false);
    });

    it('uses joined_at for active status without last_seen or pid', () => {
      expect(isMetaActive({
        status: "active",
        joined_at: new Date().toISOString(),
      })).toBe(true);
    });

    it('returns true for active without any time info', () => {
      expect(isMetaActive({ status: "active" })).toBe(true);
    });
  });
});
