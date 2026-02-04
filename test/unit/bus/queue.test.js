const QueueManager = require('../../../src/bus/queue');
const fs = require('fs');
const path = require('path');

describe('QueueManager', () => {
  const testBusDir = '/tmp/ufoo-queue-test';
  let manager;

  beforeEach(() => {
    if (fs.existsSync(testBusDir)) {
      fs.rmSync(testBusDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testBusDir, { recursive: true });
    manager = new QueueManager(testBusDir);
  });

  afterEach(() => {
    if (fs.existsSync(testBusDir)) {
      fs.rmSync(testBusDir, { recursive: true, force: true });
    }
  });

  describe('getQueueDir', () => {
    it('should return correct queue directory path', () => {
      const queueDir = manager.getQueueDir('claude-code:abc123');
      expect(queueDir).toBe(path.join(testBusDir, 'queues', 'claude-code_abc123'));
    });

    it('should convert colon to underscore in path', () => {
      const queueDir = manager.getQueueDir('codex:xyz789');
      expect(queueDir).toContain('codex_xyz789');
      expect(queueDir).not.toContain('codex:xyz789');
    });
  });

  describe('ensureQueueDir', () => {
    it('should create queue directory if not exists', () => {
      const queueDir = manager.ensureQueueDir('claude-code:test123');
      expect(fs.existsSync(queueDir)).toBe(true);
      expect(fs.statSync(queueDir).isDirectory()).toBe(true);
    });

    it('should not fail if directory already exists', () => {
      const queueDir = manager.ensureQueueDir('claude-code:test123');
      expect(() => manager.ensureQueueDir('claude-code:test123')).not.toThrow();
      expect(fs.existsSync(queueDir)).toBe(true);
    });
  });

  describe('path getters', () => {
    it('getOffsetPath should return correct offset file path', () => {
      const offsetPath = manager.getOffsetPath('claude-code:abc123');
      expect(offsetPath).toBe(path.join(testBusDir, 'queues', 'claude-code_abc123.offset'));
    });

    it('getPendingPath should return correct pending file path', () => {
      const pendingPath = manager.getPendingPath('codex:xyz789');
      expect(pendingPath).toBe(path.join(testBusDir, 'queues', 'codex_xyz789', 'pending.jsonl'));
    });

    it('getTtyPath should return correct tty file path', () => {
      const ttyPath = manager.getTtyPath('claude-code:test');
      expect(ttyPath).toBe(path.join(testBusDir, 'queues', 'claude-code_test', 'tty'));
    });
  });

  describe('offset operations', () => {
    describe('getOffset', () => {
      it('should return 0 for non-existent offset file', async () => {
        const offset = await manager.getOffset('claude-code:new');
        expect(offset).toBe(0);
      });

      it('should read existing offset value', async () => {
        await manager.setOffset('claude-code:test', 42);
        const offset = await manager.getOffset('claude-code:test');
        expect(offset).toBe(42);
      });

      it('should handle large offset values', async () => {
        await manager.setOffset('codex:test', 999999);
        const offset = await manager.getOffset('codex:test');
        expect(offset).toBe(999999);
      });

      it('should return 0 for invalid offset content', async () => {
        const offsetPath = manager.getOffsetPath('test:invalid');
        fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
        fs.writeFileSync(offsetPath, 'invalid', 'utf8');
        const offset = await manager.getOffset('test:invalid');
        expect(offset).toBe(0);
      });
    });

    describe('setOffset', () => {
      it('should write offset value', async () => {
        await manager.setOffset('claude-code:test', 100);
        const offsetPath = manager.getOffsetPath('claude-code:test');
        expect(fs.existsSync(offsetPath)).toBe(true);
        const content = fs.readFileSync(offsetPath, 'utf8');
        expect(content.trim()).toBe('100');
      });

      it('should create parent directories', async () => {
        await manager.setOffset('new:agent', 50);
        const offsetPath = manager.getOffsetPath('new:agent');
        expect(fs.existsSync(offsetPath)).toBe(true);
      });

      it('should overwrite existing offset', async () => {
        await manager.setOffset('claude-code:test', 10);
        await manager.setOffset('claude-code:test', 20);
        const offset = await manager.getOffset('claude-code:test');
        expect(offset).toBe(20);
      });
    });
  });

  describe('pending message operations', () => {
    describe('readPending', () => {
      it('should return empty array for non-existent file', async () => {
        const pending = await manager.readPending('claude-code:new');
        expect(pending).toEqual([]);
      });

      it('should read existing pending messages', async () => {
        const event1 = { seq: 1, from: 'sender', to: 'receiver', message: 'hello' };
        const event2 = { seq: 2, from: 'sender', to: 'receiver', message: 'world' };

        await manager.appendPending('claude-code:test', event1);
        await manager.appendPending('claude-code:test', event2);

        const pending = await manager.readPending('claude-code:test');
        expect(pending).toHaveLength(2);
        expect(pending[0]).toEqual(event1);
        expect(pending[1]).toEqual(event2);
      });
    });

    describe('appendPending', () => {
      it('should append message to pending queue', async () => {
        const event = { seq: 1, from: 'test', message: 'data' };
        await manager.appendPending('claude-code:test', event);

        const pending = await manager.readPending('claude-code:test');
        expect(pending).toHaveLength(1);
        expect(pending[0]).toEqual(event);
      });

      it('should create queue directory if not exists', async () => {
        const event = { seq: 1, message: 'test' };
        await manager.appendPending('new:agent', event);

        const queueDir = manager.getQueueDir('new:agent');
        expect(fs.existsSync(queueDir)).toBe(true);
      });

      it('should append multiple messages in order', async () => {
        const events = [
          { seq: 1, message: 'first' },
          { seq: 2, message: 'second' },
          { seq: 3, message: 'third' },
        ];

        for (const event of events) {
          await manager.appendPending('codex:test', event);
        }

        const pending = await manager.readPending('codex:test');
        expect(pending).toHaveLength(3);
        expect(pending[0].message).toBe('first');
        expect(pending[2].message).toBe('third');
      });
    });

    describe('clearPending', () => {
      it('should clear all pending messages', async () => {
        await manager.appendPending('claude-code:test', { seq: 1, message: 'msg1' });
        await manager.appendPending('claude-code:test', { seq: 2, message: 'msg2' });

        await manager.clearPending('claude-code:test');

        const pending = await manager.readPending('claude-code:test');
        expect(pending).toEqual([]);
      });

      it('should not fail if file does not exist', async () => {
        await expect(manager.clearPending('nonexistent:agent')).resolves.not.toThrow();
      });

      it('should allow new messages after clear', async () => {
        await manager.appendPending('claude-code:test', { seq: 1, message: 'old' });
        await manager.clearPending('claude-code:test');
        await manager.appendPending('claude-code:test', { seq: 2, message: 'new' });

        const pending = await manager.readPending('claude-code:test');
        expect(pending).toHaveLength(1);
        expect(pending[0].message).toBe('new');
      });
    });

    describe('hasPending', () => {
      it('should return false for empty queue', async () => {
        const hasPending = await manager.hasPending('claude-code:test');
        expect(hasPending).toBe(false);
      });

      it('should return true when messages exist', async () => {
        await manager.appendPending('claude-code:test', { seq: 1, message: 'test' });
        const hasPending = await manager.hasPending('claude-code:test');
        expect(hasPending).toBe(true);
      });

      it('should return false after clearing queue', async () => {
        await manager.appendPending('claude-code:test', { seq: 1, message: 'test' });
        await manager.clearPending('claude-code:test');
        const hasPending = await manager.hasPending('claude-code:test');
        expect(hasPending).toBe(false);
      });
    });
  });

  describe('tty operations', () => {
    describe('saveTty', () => {
      it('should save tty device path', async () => {
        await manager.saveTty('claude-code:test', '/dev/ttys001');
        const ttyPath = manager.getTtyPath('claude-code:test');
        expect(fs.existsSync(ttyPath)).toBe(true);
        const content = fs.readFileSync(ttyPath, 'utf8');
        expect(content).toBe('/dev/ttys001');
      });

      it('should create queue directory if not exists', async () => {
        await manager.saveTty('new:agent', '/dev/ttys002');
        const queueDir = manager.getQueueDir('new:agent');
        expect(fs.existsSync(queueDir)).toBe(true);
      });

      it('should overwrite existing tty', async () => {
        await manager.saveTty('claude-code:test', '/dev/ttys001');
        await manager.saveTty('claude-code:test', '/dev/ttys002');
        const tty = await manager.readTty('claude-code:test');
        expect(tty).toBe('/dev/ttys002');
      });
    });

    describe('readTty', () => {
      it('should return null for non-existent tty file', async () => {
        const tty = await manager.readTty('claude-code:new');
        expect(tty).toBeNull();
      });

      it('should read existing tty device path', async () => {
        await manager.saveTty('codex:test', '/dev/ttys003');
        const tty = await manager.readTty('codex:test');
        expect(tty).toBe('/dev/ttys003');
      });

      it('should trim whitespace from tty path', async () => {
        const ttyPath = manager.getTtyPath('test:whitespace');
        fs.mkdirSync(path.dirname(ttyPath), { recursive: true });
        fs.writeFileSync(ttyPath, '  /dev/ttys004  \n', 'utf8');
        const tty = await manager.readTty('test:whitespace');
        expect(tty).toBe('/dev/ttys004');
      });
    });
  });

  describe('edge cases', () => {
    it('should handle subscriber names with special characters', async () => {
      await manager.setOffset('test-agent:123-456', 10);
      const offset = await manager.getOffset('test-agent:123-456');
      expect(offset).toBe(10);
    });

    it('should handle concurrent operations on same subscriber', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(manager.appendPending('claude-code:test', { seq: i, message: `msg${i}` }));
      }
      await Promise.all(promises);

      const pending = await manager.readPending('claude-code:test');
      expect(pending.length).toBeGreaterThan(0);
    });

    it('should handle empty message objects', async () => {
      await manager.appendPending('claude-code:test', {});
      const pending = await manager.readPending('claude-code:test');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toEqual({});
    });

    it('should handle messages with complex nested data', async () => {
      const complexEvent = {
        seq: 1,
        from: 'sender',
        to: 'receiver',
        message: 'test',
        metadata: {
          nested: {
            deep: {
              value: 'data',
            },
          },
          array: [1, 2, 3],
        },
      };

      await manager.appendPending('claude-code:test', complexEvent);
      const pending = await manager.readPending('claude-code:test');
      expect(pending[0]).toEqual(complexEvent);
    });
  });
});
