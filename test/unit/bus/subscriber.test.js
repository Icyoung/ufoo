const fs = require('fs');
const os = require('os');
const path = require('path');
const SubscriberManager = require('../../../src/coordination/bus/subscriber');

describe('SubscriberManager', () => {
  let busData;
  let mockQueueManager;
  let manager;

  beforeEach(() => {
    busData = {
      agents: {},
    };

    mockQueueManager = {
      ensureQueueDir: jest.fn(),
      saveTty: jest.fn(),
      getQueueDir: jest.fn((subscriber) => `/tmp/${subscriber}`),
      getOffsetPath: jest.fn((subscriber) => `/tmp/${subscriber}.offset`),
    };

    manager = new SubscriberManager(busData, mockQueueManager);
  });

  describe('join', () => {
    it('should join with auto-generated nickname', async () => {
      const result = await manager.join('abc123', 'claude-code');

      expect(result.subscriber).toBe('claude-code:abc123');
      expect(result.nickname).toBe('claude-1');
      expect(busData.agents['claude-code:abc123']).toBeDefined();
      expect(busData.agents['claude-code:abc123'].status).toBe('active');
    });

    it('should join with custom nickname', async () => {
      const result = await manager.join('xyz789', 'codex', 'my-agent', {
        scopedNickname: 'neptune-my-agent',
      });

      expect(result.nickname).toBe('my-agent');
      expect(busData.agents['codex:xyz789'].nickname).toBe('my-agent');
      expect(busData.agents['codex:xyz789'].scoped_nickname).toBe('neptune-my-agent');
    });

    it('should throw error for duplicate nickname', async () => {
      await manager.join('abc123', 'claude-code', 'architect');

      await expect(
        manager.join('xyz789', 'codex', 'architect')
      ).rejects.toThrow('Nickname "architect" already exists');
    });

    it('should preserve nickname on rejoin', async () => {
      // First join
      await manager.join('abc123', 'claude-code', 'architect');

      // Mark as inactive (simulating leave)
      busData.agents['claude-code:abc123'].status = 'inactive';

      // Rejoin without nickname
      const result = await manager.join('abc123', 'claude-code');

      expect(result.nickname).toBe('architect');
      expect(busData.agents['claude-code:abc123'].nickname).toBe('architect');
    });

    it('should create queue directory', async () => {
      await manager.join('abc123', 'claude-code');

      expect(mockQueueManager.ensureQueueDir).toHaveBeenCalledWith('claude-code:abc123');
    });

    it('should save tty information if available', async () => {
      // Mock stdin to simulate TTY
      const originalIsTTY = process.stdin.isTTY;
      const originalTtyPath = process.stdin.ttyPath;

      process.stdin.isTTY = true;
      process.stdin.ttyPath = '/dev/ttys001';

      await manager.join('abc123', 'claude-code');

      expect(mockQueueManager.saveTty).toHaveBeenCalledWith(
        'claude-code:abc123',
        '/dev/ttys001'
      );

      // Restore
      process.stdin.isTTY = originalIsTTY;
      process.stdin.ttyPath = originalTtyPath;
    });

    it('should set joined_at timestamp on first join', async () => {
      await manager.join('abc123', 'claude-code');

      const meta = busData.agents['claude-code:abc123'];
      expect(meta.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should preserve joined_at on rejoin', async () => {
      await manager.join('abc123', 'claude-code');
      const originalJoinedAt = busData.agents['claude-code:abc123'].joined_at;

      // Wait a bit and rejoin
      await new Promise(resolve => setTimeout(resolve, 10));
      await manager.join('abc123', 'claude-code');

      expect(busData.agents['claude-code:abc123'].joined_at).toBe(originalJoinedAt);
    });

    it('should update last_seen on join', async () => {
      await manager.join('abc123', 'claude-code');

      const meta = busData.agents['claude-code:abc123'];
      expect(meta.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should initialize activity state timestamp on join', async () => {
      await manager.join('abc123', 'claude-code');

      const meta = busData.agents['claude-code:abc123'];
      expect(meta.activity_state).toBe('starting');
      expect(meta.activity_since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should store process PID', async () => {
      await manager.join('abc123', 'claude-code');

      expect(busData.agents['claude-code:abc123'].pid).toBe(process.pid);
    });

    it('should initialize subscribers object if not exists', async () => {
      const emptyBusData = {};
      const emptyManager = new SubscriberManager(emptyBusData, mockQueueManager);

      await emptyManager.join('abc123', 'claude-code');

      expect(emptyBusData.agents).toBeDefined();
      expect(emptyBusData.agents['claude-code:abc123']).toBeDefined();
    });

    it('should generate sequential nicknames for multiple joins', async () => {
      const result1 = await manager.join('abc1', 'claude-code');
      const result2 = await manager.join('abc2', 'claude-code');
      const result3 = await manager.join('abc3', 'claude-code');

      expect(result1.nickname).toBe('claude-1');
      expect(result2.nickname).toBe('claude-2');
      expect(result3.nickname).toBe('claude-3');
    });

    it('should not inherit nickname from a displaced subscriber with a different agent type', async () => {
      busData.agents['claude-code:old'] = {
        agent_type: 'claude-code',
        nickname: 'claude-23',
        status: 'active',
        tty: '/dev/ttys777',
      };

      const result = await manager.join('newcodex', 'codex', '', {
        tty: '/dev/ttys777',
      });

      expect(result.subscriber).toBe('codex:newcodex');
      expect(result.nickname).toBe('codex-1');
      expect(busData.agents['claude-code:old']).toBeUndefined();
      expect(busData.agents['codex:newcodex'].nickname).toBe('codex-1');
      expect(busData.agents['codex:newcodex'].scoped_nickname).toBe('codex-1');
    });

    it('should still inherit nickname when replacing the same agent type on the same tty', async () => {
      busData.agents['codex:old'] = {
        agent_type: 'codex',
        nickname: 'builder',
        status: 'active',
        tty: '/dev/ttys778',
      };

      const result = await manager.join('newcodex', 'codex', '', {
        tty: '/dev/ttys778',
      });

      expect(result.subscriber).toBe('codex:newcodex');
      expect(result.nickname).toBe('builder');
      expect(busData.agents['codex:old']).toBeUndefined();
      expect(busData.agents['codex:newcodex'].nickname).toBe('builder');
    });
  });

  describe('leave', () => {
    it('should mark subscriber as inactive', async () => {
      await manager.join('abc123', 'claude-code');

      const result = await manager.leave('claude-code:abc123');

      expect(result).toBe(true);
      expect(busData.agents['claude-code:abc123'].status).toBe('inactive');
      expect(mockQueueManager.getQueueDir).toHaveBeenCalledWith('claude-code:abc123');
      expect(mockQueueManager.getOffsetPath).toHaveBeenCalledWith('claude-code:abc123');
    });

    it('should update last_seen on leave', async () => {
      await manager.join('abc123', 'claude-code');
      const beforeLastSeen = busData.agents['claude-code:abc123'].last_seen;

      await new Promise(resolve => setTimeout(resolve, 10));
      await manager.leave('claude-code:abc123');

      const afterLastSeen = busData.agents['claude-code:abc123'].last_seen;
      expect(afterLastSeen).not.toBe(beforeLastSeen);
    });

    it('should return false for non-existent subscriber', async () => {
      const result = await manager.leave('nonexistent:123');
      expect(result).toBe(false);
    });

    it('should return false if subscribers object not exists', async () => {
      const emptyBusData = {};
      const emptyManager = new SubscriberManager(emptyBusData, mockQueueManager);

      const result = await emptyManager.leave('any:subscriber');
      expect(result).toBe(false);
    });

    it('should allow rejoin after leave', async () => {
      await manager.join('abc123', 'claude-code', 'architect');
      await manager.leave('claude-code:abc123');

      const result = await manager.join('abc123', 'claude-code');

      expect(result.nickname).toBe('architect');
      expect(busData.agents['claude-code:abc123'].status).toBe('active');
    });

    it('should preserve pending queue and offset on leave when messages are undelivered', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-subscriber-'));
      try {
        const queueDir = path.join(tmpDir, 'queues', 'claude-code_abc1');
        const offsetPath = path.join(tmpDir, 'offsets', 'claude-code_abc1.offset');
        const pendingPath = path.join(queueDir, 'pending.jsonl');
        fs.mkdirSync(queueDir, { recursive: true });
        fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
        fs.writeFileSync(pendingPath, '{"event":"wake","seq":1}\n');
        fs.writeFileSync(offsetPath, '3\n');

        busData.agents['claude-code:abc1'] = {
          agent_type: 'claude-code',
          nickname: 'claude-1',
          status: 'active',
          pid: process.pid,
        };
        const fileQueueManager = {
          getQueueDir: jest.fn(() => queueDir),
          getOffsetPath: jest.fn(() => offsetPath),
          getPendingPath: jest.fn(() => pendingPath),
        };
        const fileManager = new SubscriberManager(busData, fileQueueManager);

        await fileManager.leave('claude-code:abc1');

        expect(busData.agents['claude-code:abc1'].status).toBe('inactive');
        expect(fs.existsSync(pendingPath)).toBe(true);
        expect(fs.readFileSync(pendingPath, 'utf8')).toBe('{"event":"wake","seq":1}\n');
        expect(fs.existsSync(offsetPath)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('rename', () => {
    it('should rename subscriber', async () => {
      await manager.join('abc123', 'claude-code', 'old-name');

      const result = await manager.rename('claude-code:abc123', 'new-name', {
        scopedNickname: 'neptune-new-name',
      });

      expect(result.oldNickname).toBe('old-name');
      expect(result.newNickname).toBe('new-name');
      expect(busData.agents['claude-code:abc123'].nickname).toBe('new-name');
      expect(busData.agents['claude-code:abc123'].scoped_nickname).toBe('neptune-new-name');
    });

    it('should throw error for non-existent subscriber', async () => {
      await expect(
        manager.rename('nonexistent:123', 'new-name')
      ).rejects.toThrow('Subscriber "nonexistent:123" not found');
    });

    it('should throw error for duplicate nickname', async () => {
      await manager.join('abc123', 'claude-code', 'name1');
      await manager.join('xyz789', 'codex', 'name2');

      await expect(
        manager.rename('claude-code:abc123', 'name2')
      ).rejects.toThrow('Nickname "name2" already exists');
    });

    it('should allow renaming to same nickname', async () => {
      await manager.join('abc123', 'claude-code', 'my-name');

      const result = await manager.rename('claude-code:abc123', 'my-name');

      expect(result.newNickname).toBe('my-name');
      expect(busData.agents['claude-code:abc123'].nickname).toBe('my-name');
    });
  });

  describe('getActiveSubscribers', () => {
    it('should return empty array if no subscribers', () => {
      const active = manager.getActiveSubscribers();
      expect(active).toEqual([]);
    });

    it('should return only active subscribers', async () => {
      await manager.join('abc1', 'claude-code');
      await manager.join('abc2', 'codex');
      await manager.leave('claude-code:abc1');

      const active = manager.getActiveSubscribers();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('codex:abc2');
    });

    it('should filter out subscribers with dead PIDs', async () => {
      await manager.join('abc1', 'claude-code');
      await manager.join('abc2', 'codex');

      // Mock dead PID
      busData.agents['claude-code:abc1'].pid = 999999;

      const active = manager.getActiveSubscribers();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('codex:abc2');
    });

    it('should include subscribers without PID', async () => {
      await manager.join('abc1', 'claude-code');
      delete busData.agents['claude-code:abc1'].pid;

      const active = manager.getActiveSubscribers();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('claude-code:abc1');
    });

    it('should return subscribers with metadata', async () => {
      await manager.join('abc1', 'claude-code', 'architect');

      const active = manager.getActiveSubscribers();

      expect(active[0]).toMatchObject({
        id: 'claude-code:abc1',
        nickname: 'architect',
        status: 'active',
        agent_type: 'claude-code',
      });
    });
  });

  describe('getSubscriber', () => {
    it('should return subscriber metadata', async () => {
      await manager.join('abc123', 'claude-code', 'architect');

      const meta = manager.getSubscriber('claude-code:abc123');

      expect(meta).toMatchObject({
        nickname: 'architect',
        status: 'active',
        agent_type: 'claude-code',
      });
    });

    it('should return null for non-existent subscriber', () => {
      const meta = manager.getSubscriber('nonexistent:123');
      expect(meta).toBeNull();
    });

    it('should return null if subscribers object not exists', () => {
      const emptyManager = new SubscriberManager({}, mockQueueManager);
      const meta = emptyManager.getSubscriber('any:subscriber');
      expect(meta).toBeNull();
    });
  });

  describe('updateLastSeen', () => {
    it('should update last_seen timestamp', async () => {
      await manager.join('abc123', 'claude-code');
      const beforeLastSeen = busData.agents['claude-code:abc123'].last_seen;

      await new Promise(resolve => setTimeout(resolve, 10));
      manager.updateLastSeen('claude-code:abc123');

      const afterLastSeen = busData.agents['claude-code:abc123'].last_seen;
      expect(afterLastSeen).not.toBe(beforeLastSeen);
    });

    it('should do nothing for non-existent subscriber', () => {
      expect(() => manager.updateLastSeen('nonexistent:123')).not.toThrow();
    });

    it('should do nothing if subscribers object not exists', () => {
      const emptyManager = new SubscriberManager({}, mockQueueManager);
      expect(() => emptyManager.updateLastSeen('any:subscriber')).not.toThrow();
    });
  });

  describe('cleanupInactive', () => {
    it('should mark dead PIDs as inactive', async () => {
      await manager.join('abc1', 'claude-code');
      await manager.join('abc2', 'codex');

      // Mock dead PID
      busData.agents['claude-code:abc1'].pid = 999999;

      manager.cleanupInactive();

      expect(busData.agents['claude-code:abc1'].status).toBe('inactive');
      expect(busData.agents['codex:abc2'].status).toBe('active');
    });

    it('should not mark subscribers without PID as inactive', async () => {
      await manager.join('abc1', 'claude-code');
      delete busData.agents['claude-code:abc1'].pid;

      manager.cleanupInactive();

      expect(busData.agents['claude-code:abc1'].status).toBe('active');
    });

    it('should not affect already inactive subscribers', async () => {
      await manager.join('abc1', 'claude-code');
      await manager.leave('claude-code:abc1');

      const lastSeenBefore = busData.agents['claude-code:abc1'].last_seen;

      await new Promise(resolve => setTimeout(resolve, 10));
      manager.cleanupInactive();

      expect(busData.agents['claude-code:abc1'].status).toBe('inactive');
      expect(busData.agents['claude-code:abc1'].last_seen).toBe(lastSeenBefore);
    });

    it('should do nothing if no subscribers', () => {
      expect(() => manager.cleanupInactive()).not.toThrow();
    });

    it('should update last_seen when marking inactive', async () => {
      await manager.join('abc1', 'claude-code');
      const lastSeenBefore = busData.agents['claude-code:abc1'].last_seen;

      busData.agents['claude-code:abc1'].pid = 999999;

      await new Promise(resolve => setTimeout(resolve, 10));
      manager.cleanupInactive();

      expect(busData.agents['claude-code:abc1'].last_seen).not.toBe(lastSeenBefore);
    });

    it('should cleanup queue artifacts when marking inactive', async () => {
      await manager.join('abc1', 'claude-code');
      busData.agents['claude-code:abc1'].pid = 999999;

      manager.cleanupInactive();

      expect(mockQueueManager.getQueueDir).toHaveBeenCalledWith('claude-code:abc1');
      expect(mockQueueManager.getOffsetPath).toHaveBeenCalledWith('claude-code:abc1');
    });

    it('should preserve pending queue and offset when marking inactive with undelivered messages', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-subscriber-'));
      try {
        const queueDir = path.join(tmpDir, 'queues', 'claude-code_abc1');
        const offsetPath = path.join(tmpDir, 'offsets', 'claude-code_abc1.offset');
        const pendingPath = path.join(queueDir, 'pending.jsonl');
        fs.mkdirSync(queueDir, { recursive: true });
        fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
        fs.writeFileSync(pendingPath, '{"event":"wake","seq":1}\n');
        fs.writeFileSync(offsetPath, '3\n');

        busData.agents['claude-code:abc1'] = {
          agent_type: 'claude-code',
          nickname: 'claude-1',
          status: 'active',
          pid: 999999,
        };
        const fileQueueManager = {
          getQueueDir: jest.fn(() => queueDir),
          getOffsetPath: jest.fn(() => offsetPath),
          getPendingPath: jest.fn(() => pendingPath),
        };
        const fileManager = new SubscriberManager(busData, fileQueueManager);

        fileManager.cleanupInactive();

        expect(busData.agents['claude-code:abc1'].status).toBe('inactive');
        expect(fs.existsSync(pendingPath)).toBe(true);
        expect(fs.readFileSync(pendingPath, 'utf8')).toBe('{"event":"wake","seq":1}\n');
        expect(fs.existsSync(offsetPath)).toBe(true);
        expect(fs.readFileSync(offsetPath, 'utf8')).toBe('3\n');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should still cleanup queue artifacts when pending queue is empty', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-subscriber-'));
      try {
        const queueDir = path.join(tmpDir, 'queues', 'claude-code_abc1');
        const offsetPath = path.join(tmpDir, 'offsets', 'claude-code_abc1.offset');
        fs.mkdirSync(queueDir, { recursive: true });
        fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
        fs.writeFileSync(path.join(queueDir, 'pending.jsonl'), '');
        fs.writeFileSync(offsetPath, '3\n');

        busData.agents['claude-code:abc1'] = {
          agent_type: 'claude-code',
          nickname: 'claude-1',
          status: 'active',
          pid: 999999,
        };
        const fileQueueManager = {
          getQueueDir: jest.fn(() => queueDir),
          getOffsetPath: jest.fn(() => offsetPath),
          getPendingPath: jest.fn(() => path.join(queueDir, 'pending.jsonl')),
        };
        const fileManager = new SubscriberManager(busData, fileQueueManager);

        fileManager.cleanupInactive();

        expect(busData.agents['claude-code:abc1'].status).toBe('inactive');
        expect(fs.existsSync(queueDir)).toBe(false);
        expect(fs.existsSync(offsetPath)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should remove dead internal subscribers without provider sessions from the registry', async () => {
      await manager.join('abc1', 'claude-code', '', {
        launchMode: 'internal',
        parentPid: 999999,
      });

      manager.cleanupInactive();

      expect(busData.agents['claude-code:abc1']).toBeUndefined();
      expect(mockQueueManager.getQueueDir).toHaveBeenCalledWith('claude-code:abc1');
      expect(mockQueueManager.getOffsetPath).toHaveBeenCalledWith('claude-code:abc1');
    });

    it('should keep dead internal subscribers with provider sessions as recoverable', async () => {
      await manager.join('abc1', 'claude-code', '', {
        launchMode: 'internal',
        parentPid: 999999,
        providerSessionId: 'sess-1',
      });

      manager.cleanupInactive();

      expect(busData.agents['claude-code:abc1']).toMatchObject({
        status: 'inactive',
        provider_session_id: 'sess-1',
        launch_mode: 'internal',
      });
      expect(mockQueueManager.getQueueDir).toHaveBeenCalledWith('claude-code:abc1');
      expect(mockQueueManager.getOffsetPath).toHaveBeenCalledWith('claude-code:abc1');
    });

    it('should remove already inactive internal subscribers without provider sessions from the registry', () => {
      busData.agents['codex:old'] = {
        agent_type: 'codex',
        nickname: 'codex-1',
        status: 'inactive',
        launch_mode: 'internal',
        pid: 999999,
      };

      manager.cleanupInactive();

      expect(busData.agents['codex:old']).toBeUndefined();
    });

    it('should keep already inactive internal subscribers with provider sessions as recoverable', () => {
      busData.agents['codex:old'] = {
        agent_type: 'codex',
        nickname: 'codex-1',
        status: 'inactive',
        launch_mode: 'internal',
        provider_session_id: 'sess-1',
        pid: 999999,
      };

      manager.cleanupInactive();

      expect(busData.agents['codex:old']).toBeDefined();
    });

    it('should keep already inactive non-internal subscribers for resume', () => {
      busData.agents['codex:old'] = {
        agent_type: 'codex',
        nickname: 'codex-1',
        status: 'inactive',
        launch_mode: 'terminal',
        provider_session_id: 'sess-1',
        pid: 999999,
      };

      manager.cleanupInactive();

      expect(busData.agents['codex:old']).toBeDefined();
    });
  });

  describe('cleanupDuplicateTty', () => {
    function setupDuplicateTtyFiles(tmpDir) {
      const { DeliveryQueue } = require('../../../src/coordination/bus/deliveryQueue');
      const queueDirOf = (name) => path.join(tmpDir, 'queues', name);
      const pendingPathOf = (name) => path.join(queueDirOf(name), 'pending.jsonl');
      fs.mkdirSync(queueDirOf('claude-code_old1'), { recursive: true });
      fs.mkdirSync(queueDirOf('claude-code_new1'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'offsets'), { recursive: true });
      const events = [
        { event: 'message', seq: 1, data: { message: 'hello-1' } },
        { event: 'message', seq: 2, data: { message: 'hello-2' } },
      ];
      fs.writeFileSync(pendingPathOf('claude-code_old1'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const offsetOf = (name) => path.join(tmpDir, 'offsets', `${name}.offset`);
      fs.writeFileSync(offsetOf('claude-code_old1'), '2\n');
      return { queueDirOf, pendingPathOf, offsetOf, DeliveryQueue, events };
    }

    it('should migrate undelivered messages to the replacement subscriber', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-duptty-'));
      try {
        const { queueDirOf, pendingPathOf, DeliveryQueue, events } = setupDuplicateTtyFiles(tmpDir);
        const fileQueueManager = {
          getQueueDir: jest.fn((s) => queueDirOf(s.replace(':', '_'))),
          getOffsetPath: jest.fn((s) => path.join(tmpDir, 'offsets', `${s.replace(':', '_')}.offset`)),
          getPendingPath: jest.fn((s) => pendingPathOf(s.replace(':', '_'))),
          getDeliveryQueue: jest.fn((s) => new DeliveryQueue(pendingPathOf(s.replace(':', '_')))),
          appendPending: jest.fn(async (s, event) => {
            new DeliveryQueue(pendingPathOf(s.replace(':', '_'))).append(event);
          }),
          clearPending: jest.fn(async (s) => {
            fs.writeFileSync(pendingPathOf(s.replace(':', '_')), '');
          }),
        };
        busData.agents['claude-code:old1'] = {
          agent_type: 'claude-code', nickname: 'old-one', status: 'active', tty: '/dev/ttys099',
        };
        busData.agents['claude-code:new1'] = {
          agent_type: 'claude-code', nickname: 'new-one', status: 'active', tty: '/dev/ttys099',
        };
        const fileManager = new SubscriberManager(busData, fileQueueManager);

        await fileManager.cleanupDuplicateTty('claude-code:new1', '/dev/ttys099', { agentType: 'claude-code' });

        expect(busData.agents['claude-code:old1']).toBeUndefined();
        const migrated = new DeliveryQueue(pendingPathOf('claude-code_new1')).readPending();
        expect(migrated.map((e) => e.data.message)).toEqual(['hello-1', 'hello-2']);
        expect(fs.existsSync(queueDirOf('claude-code_old1'))).toBe(false);
        expect(events).toHaveLength(2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should keep the stale queue when migration is not possible', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-duptty-'));
      try {
        const { queueDirOf, pendingPathOf } = setupDuplicateTtyFiles(tmpDir);
        const fileQueueManager = {
          getQueueDir: jest.fn((s) => queueDirOf(s.replace(':', '_'))),
          getOffsetPath: jest.fn((s) => path.join(tmpDir, 'offsets', `${s.replace(':', '_')}.offset`)),
          getPendingPath: jest.fn((s) => pendingPathOf(s.replace(':', '_'))),
        };
        busData.agents['claude-code:old1'] = {
          agent_type: 'claude-code', nickname: 'old-one', status: 'active', tty: '/dev/ttys099',
        };
        busData.agents['claude-code:new1'] = {
          agent_type: 'claude-code', nickname: 'new-one', status: 'active', tty: '/dev/ttys099',
        };
        const fileManager = new SubscriberManager(busData, fileQueueManager);

        await fileManager.cleanupDuplicateTty('claude-code:new1', '/dev/ttys099', { agentType: 'claude-code' });

        expect(busData.agents['claude-code:old1']).toBeUndefined();
        expect(fs.existsSync(pendingPathOf('claude-code_old1'))).toBe(true);
        expect(fs.readFileSync(pendingPathOf('claude-code_old1'), 'utf8')).toContain('hello-1');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases', () => {
    it('should handle rapid sequential joins', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(manager.join(`session${i}`, 'claude-code'));
      }

      const results = await Promise.all(promises);

      const nicknames = results.map(r => r.nickname);
      const uniqueNicknames = new Set(nicknames);
      expect(uniqueNicknames.size).toBe(10); // All should be unique
    });

    it('should handle subscriber IDs with special characters', async () => {
      await manager.join('abc-123_456', 'claude-code');

      const meta = manager.getSubscriber('claude-code:abc-123_456');
      expect(meta).not.toBeNull();
    });

    it('should handle long session IDs', async () => {
      const longId = 'a'.repeat(100);
      await manager.join(longId, 'claude-code');

      const subscriber = `claude-code:${longId}`;
      const meta = manager.getSubscriber(subscriber);
      expect(meta).not.toBeNull();
    });

    it('should handle agent types with hyphens', async () => {
      await manager.join('abc123', 'custom-agent-type');

      const meta = manager.getSubscriber('custom-agent-type:abc123');
      expect(meta.agent_type).toBe('custom-agent-type');
    });
  });
});
