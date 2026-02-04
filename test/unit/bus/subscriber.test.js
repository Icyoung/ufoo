const SubscriberManager = require('../../../src/bus/subscriber');

describe('SubscriberManager', () => {
  let busData;
  let mockQueueManager;
  let manager;

  beforeEach(() => {
    busData = {
      subscribers: {},
    };

    mockQueueManager = {
      ensureQueueDir: jest.fn(),
      saveTty: jest.fn(),
    };

    manager = new SubscriberManager(busData, mockQueueManager);
  });

  describe('join', () => {
    it('should join with auto-generated nickname', async () => {
      const result = await manager.join('abc123', 'claude-code');

      expect(result.subscriber).toBe('claude-code:abc123');
      expect(result.nickname).toBe('claude-1');
      expect(busData.subscribers['claude-code:abc123']).toBeDefined();
      expect(busData.subscribers['claude-code:abc123'].status).toBe('active');
    });

    it('should join with custom nickname', async () => {
      const result = await manager.join('xyz789', 'codex', 'my-agent');

      expect(result.nickname).toBe('my-agent');
      expect(busData.subscribers['codex:xyz789'].nickname).toBe('my-agent');
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
      busData.subscribers['claude-code:abc123'].status = 'inactive';

      // Rejoin without nickname
      const result = await manager.join('abc123', 'claude-code');

      expect(result.nickname).toBe('architect');
      expect(busData.subscribers['claude-code:abc123'].nickname).toBe('architect');
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

      const meta = busData.subscribers['claude-code:abc123'];
      expect(meta.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should preserve joined_at on rejoin', async () => {
      await manager.join('abc123', 'claude-code');
      const originalJoinedAt = busData.subscribers['claude-code:abc123'].joined_at;

      // Wait a bit and rejoin
      await new Promise(resolve => setTimeout(resolve, 10));
      await manager.join('abc123', 'claude-code');

      expect(busData.subscribers['claude-code:abc123'].joined_at).toBe(originalJoinedAt);
    });

    it('should update last_seen on join', async () => {
      await manager.join('abc123', 'claude-code');

      const meta = busData.subscribers['claude-code:abc123'];
      expect(meta.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should store process PID', async () => {
      await manager.join('abc123', 'claude-code');

      expect(busData.subscribers['claude-code:abc123'].pid).toBe(process.pid);
    });

    it('should initialize subscribers object if not exists', async () => {
      const emptyBusData = {};
      const emptyManager = new SubscriberManager(emptyBusData, mockQueueManager);

      await emptyManager.join('abc123', 'claude-code');

      expect(emptyBusData.subscribers).toBeDefined();
      expect(emptyBusData.subscribers['claude-code:abc123']).toBeDefined();
    });

    it('should generate sequential nicknames for multiple joins', async () => {
      const result1 = await manager.join('abc1', 'claude-code');
      const result2 = await manager.join('abc2', 'claude-code');
      const result3 = await manager.join('abc3', 'claude-code');

      expect(result1.nickname).toBe('claude-1');
      expect(result2.nickname).toBe('claude-2');
      expect(result3.nickname).toBe('claude-3');
    });
  });

  describe('leave', () => {
    it('should mark subscriber as inactive', async () => {
      await manager.join('abc123', 'claude-code');

      const result = await manager.leave('claude-code:abc123');

      expect(result).toBe(true);
      expect(busData.subscribers['claude-code:abc123'].status).toBe('inactive');
    });

    it('should update last_seen on leave', async () => {
      await manager.join('abc123', 'claude-code');
      const beforeLastSeen = busData.subscribers['claude-code:abc123'].last_seen;

      await new Promise(resolve => setTimeout(resolve, 10));
      await manager.leave('claude-code:abc123');

      const afterLastSeen = busData.subscribers['claude-code:abc123'].last_seen;
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
      expect(busData.subscribers['claude-code:abc123'].status).toBe('active');
    });
  });

  describe('rename', () => {
    it('should rename subscriber', async () => {
      await manager.join('abc123', 'claude-code', 'old-name');

      const result = await manager.rename('claude-code:abc123', 'new-name');

      expect(result.oldNickname).toBe('old-name');
      expect(result.newNickname).toBe('new-name');
      expect(busData.subscribers['claude-code:abc123'].nickname).toBe('new-name');
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
      expect(busData.subscribers['claude-code:abc123'].nickname).toBe('my-name');
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
      busData.subscribers['claude-code:abc1'].pid = 999999;

      const active = manager.getActiveSubscribers();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('codex:abc2');
    });

    it('should include subscribers without PID', async () => {
      await manager.join('abc1', 'claude-code');
      delete busData.subscribers['claude-code:abc1'].pid;

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
      const beforeLastSeen = busData.subscribers['claude-code:abc123'].last_seen;

      await new Promise(resolve => setTimeout(resolve, 10));
      manager.updateLastSeen('claude-code:abc123');

      const afterLastSeen = busData.subscribers['claude-code:abc123'].last_seen;
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
      busData.subscribers['claude-code:abc1'].pid = 999999;

      manager.cleanupInactive();

      expect(busData.subscribers['claude-code:abc1'].status).toBe('inactive');
      expect(busData.subscribers['codex:abc2'].status).toBe('active');
    });

    it('should not mark subscribers without PID as inactive', async () => {
      await manager.join('abc1', 'claude-code');
      delete busData.subscribers['claude-code:abc1'].pid;

      manager.cleanupInactive();

      expect(busData.subscribers['claude-code:abc1'].status).toBe('active');
    });

    it('should not affect already inactive subscribers', async () => {
      await manager.join('abc1', 'claude-code');
      await manager.leave('claude-code:abc1');

      const lastSeenBefore = busData.subscribers['claude-code:abc1'].last_seen;

      await new Promise(resolve => setTimeout(resolve, 10));
      manager.cleanupInactive();

      expect(busData.subscribers['claude-code:abc1'].status).toBe('inactive');
      expect(busData.subscribers['claude-code:abc1'].last_seen).toBe(lastSeenBefore);
    });

    it('should do nothing if no subscribers', () => {
      expect(() => manager.cleanupInactive()).not.toThrow();
    });

    it('should update last_seen when marking inactive', async () => {
      await manager.join('abc1', 'claude-code');
      const lastSeenBefore = busData.subscribers['claude-code:abc1'].last_seen;

      busData.subscribers['claude-code:abc1'].pid = 999999;

      await new Promise(resolve => setTimeout(resolve, 10));
      manager.cleanupInactive();

      expect(busData.subscribers['claude-code:abc1'].last_seen).not.toBe(lastSeenBefore);
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
