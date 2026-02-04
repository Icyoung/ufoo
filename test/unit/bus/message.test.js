const MessageManager = require('../../../src/bus/message');
const fs = require('fs');
const path = require('path');
const { appendJSONL } = require('../../../src/bus/utils');

describe('MessageManager', () => {
  const testBusDir = '/tmp/ufoo-message-test';
  const eventsDir = path.join(testBusDir, 'events');
  let busData;
  let mockQueueManager;
  let manager;

  beforeEach(() => {
    if (fs.existsSync(testBusDir)) {
      fs.rmSync(testBusDir, { recursive: true, force: true });
    }
    fs.mkdirSync(eventsDir, { recursive: true });

    busData = {
      subscribers: {
        'claude-code:abc123': {
          agent_type: 'claude-code',
          nickname: 'architect',
          status: 'active',
          last_seen: '2026-01-01T00:00:00.000Z',
        },
        'codex:xyz789': {
          agent_type: 'codex',
          nickname: 'dev-lead',
          status: 'active',
          last_seen: '2026-01-01T00:00:00.000Z',
        },
        'codex:def456': {
          agent_type: 'codex',
          nickname: 'codex-1',
          status: 'inactive',
          last_seen: '2026-01-01T00:00:00.000Z',
        },
      },
    };

    mockQueueManager = {
      getOffset: jest.fn().mockResolvedValue(0),
      setOffset: jest.fn().mockResolvedValue(undefined),
      appendPending: jest.fn().mockResolvedValue(undefined),
      readPending: jest.fn().mockResolvedValue([]),
      clearPending: jest.fn().mockResolvedValue(undefined),
    };

    manager = new MessageManager(testBusDir, busData, mockQueueManager);
  });

  afterEach(() => {
    if (fs.existsSync(testBusDir)) {
      fs.rmSync(testBusDir, { recursive: true, force: true });
    }
  });

  describe('getNextSeq', () => {
    it('should return 1 for empty events directory', async () => {
      const seq = await manager.getNextSeq();
      expect(seq).toBe(1);
    });

    it('should return next sequence number from latest event', async () => {
      const eventFile = path.join(eventsDir, '2026-01-01.jsonl');
      appendJSONL(eventFile, { seq: 1, message: 'first' });
      appendJSONL(eventFile, { seq: 2, message: 'second' });
      appendJSONL(eventFile, { seq: 3, message: 'third' });

      const seq = await manager.getNextSeq();
      expect(seq).toBe(4);
    });

    it('should read from newest file first', async () => {
      appendJSONL(path.join(eventsDir, '2026-01-01.jsonl'), { seq: 5 });
      appendJSONL(path.join(eventsDir, '2026-01-02.jsonl'), { seq: 10 });
      appendJSONL(path.join(eventsDir, '2026-01-03.jsonl'), { seq: 15 });

      const seq = await manager.getNextSeq();
      expect(seq).toBe(16);
    });

    it('should handle invalid JSON lines gracefully', async () => {
      const eventFile = path.join(eventsDir, '2026-01-01.jsonl');
      fs.writeFileSync(eventFile, 'invalid json\n{"seq": 5}\n', 'utf8');

      const seq = await manager.getNextSeq();
      expect(seq).toBe(6);
    });

    it('should handle missing seq field', async () => {
      const eventFile = path.join(eventsDir, '2026-01-01.jsonl');
      appendJSONL(eventFile, { message: 'no seq' });

      const seq = await manager.getNextSeq();
      expect(seq).toBe(1);
    });
  });

  describe('resolveTarget', () => {
    it('should resolve subscriber ID directly', () => {
      const targets = manager.resolveTarget('claude-code:abc123');
      expect(targets).toEqual(['claude-code:abc123']);
    });

    it('should resolve nickname to subscriber', () => {
      const targets = manager.resolveTarget('architect');
      expect(targets).toEqual(['claude-code:abc123']);
    });

    it('should resolve agent type to all active subscribers', () => {
      const targets = manager.resolveTarget('codex');
      expect(targets).toEqual(['codex:xyz789']);
      expect(targets).not.toContain('codex:def456'); // inactive
    });

    it('should resolve wildcard to all active subscribers', () => {
      const targets = manager.resolveTarget('*');
      expect(targets).toHaveLength(2);
      expect(targets).toContain('claude-code:abc123');
      expect(targets).toContain('codex:xyz789');
      expect(targets).not.toContain('codex:def456'); // inactive
    });

    it('should return empty array for unknown target', () => {
      const targets = manager.resolveTarget('nonexistent');
      expect(targets).toEqual([]);
    });

    it('should prioritize subscriber ID over nickname', () => {
      // If target contains colon, treat as ID
      const targets = manager.resolveTarget('codex:xyz789');
      expect(targets).toEqual(['codex:xyz789']);
    });

    it('should handle multiple subscribers of same type', () => {
      busData.subscribers['codex:new123'] = {
        agent_type: 'codex',
        nickname: 'codex-2',
        status: 'active',
      };

      const targets = manager.resolveTarget('codex');
      expect(targets).toHaveLength(2);
      expect(targets).toContain('codex:xyz789');
      expect(targets).toContain('codex:new123');
    });
  });

  describe('targetMatches', () => {
    it('should match exact subscriber ID', () => {
      expect(manager.targetMatches('claude-code:abc123', 'claude-code:abc123')).toBe(true);
    });

    it('should match agent type', () => {
      expect(manager.targetMatches('codex', 'codex:xyz789')).toBe(true);
    });

    it('should match nickname', () => {
      expect(manager.targetMatches('architect', 'claude-code:abc123')).toBe(true);
    });

    it('should match wildcard', () => {
      expect(manager.targetMatches('*', 'claude-code:abc123')).toBe(true);
      expect(manager.targetMatches('*', 'codex:xyz789')).toBe(true);
    });

    it('should not match unrelated target', () => {
      expect(manager.targetMatches('other', 'claude-code:abc123')).toBe(false);
    });
  });

  describe('send', () => {
    it('should send message to single target', async () => {
      const result = await manager.send('architect', 'Hello', 'sender:123');

      expect(result.seq).toBe(1);
      expect(result.targets).toEqual(['claude-code:abc123']);
      expect(mockQueueManager.appendPending).toHaveBeenCalledWith(
        'claude-code:abc123',
        expect.objectContaining({
          seq: 1,
          type: 'message/targeted',
          publisher: 'sender:123',
          data: { message: 'Hello' },
        })
      );
    });

    it('should send to multiple targets via agent type', async () => {
      busData.subscribers['codex:new123'] = {
        agent_type: 'codex',
        nickname: 'codex-2',
        status: 'active',
      };

      const result = await manager.send('codex', 'Test', 'sender');

      expect(result.targets).toHaveLength(2);
      expect(mockQueueManager.appendPending).toHaveBeenCalledTimes(2);
    });

    it('should throw error for unknown target', async () => {
      await expect(
        manager.send('nonexistent', 'Test', 'sender')
      ).rejects.toThrow('Target "nonexistent" not found');
    });

    it('should write event to log file', async () => {
      await manager.send('architect', 'Test', 'sender');

      const files = fs.readdirSync(eventsDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    });

    it('should increment sequence number', async () => {
      const result1 = await manager.send('architect', 'First', 'sender');
      const result2 = await manager.send('architect', 'Second', 'sender');

      expect(result1.seq).toBe(1);
      expect(result2.seq).toBe(2);
    });

    it('should not add to pending if offset already past seq', async () => {
      mockQueueManager.getOffset.mockResolvedValue(10);

      await manager.send('architect', 'Test', 'sender');

      expect(mockQueueManager.appendPending).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('should send to all active subscribers', async () => {
      const result = await manager.broadcast('Broadcast message', 'sender');

      expect(result.targets).toHaveLength(2);
      expect(mockQueueManager.appendPending).toHaveBeenCalledTimes(2);
    });

    it('should use wildcard target', async () => {
      await manager.broadcast('Test', 'sender');

      expect(mockQueueManager.appendPending).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          target: '*',
        })
      );
    });
  });

  describe('check', () => {
    it('should return pending messages', async () => {
      const mockPending = [
        { seq: 1, message: 'msg1' },
        { seq: 2, message: 'msg2' },
      ];
      mockQueueManager.readPending.mockResolvedValue(mockPending);

      const pending = await manager.check('claude-code:abc123');

      expect(pending).toEqual(mockPending);
      expect(mockQueueManager.readPending).toHaveBeenCalledWith('claude-code:abc123');
    });

    it('should return empty array when no pending messages', async () => {
      mockQueueManager.readPending.mockResolvedValue([]);

      const pending = await manager.check('codex:xyz789');

      expect(pending).toEqual([]);
    });
  });

  describe('ack', () => {
    it('should clear pending messages and return count', async () => {
      const mockPending = [
        { seq: 1, message: 'msg1' },
        { seq: 2, message: 'msg2' },
      ];
      mockQueueManager.readPending.mockResolvedValue(mockPending);

      const count = await manager.ack('claude-code:abc123');

      expect(count).toBe(2);
      expect(mockQueueManager.clearPending).toHaveBeenCalledWith('claude-code:abc123');
    });

    it('should return 0 when no pending messages', async () => {
      mockQueueManager.readPending.mockResolvedValue([]);

      const count = await manager.ack('codex:xyz789');

      expect(count).toBe(0);
      expect(mockQueueManager.clearPending).not.toHaveBeenCalled();
    });
  });

  describe('consume', () => {
    beforeEach(() => {
      // Setup event log
      const eventFile = path.join(eventsDir, '2026-01-01.jsonl');
      appendJSONL(eventFile, {
        seq: 1,
        target: 'claude-code:abc123',
        message: 'msg1',
      });
      appendJSONL(eventFile, {
        seq: 2,
        target: '*',
        message: 'broadcast',
      });
      appendJSONL(eventFile, {
        seq: 3,
        target: 'codex:xyz789',
        message: 'msg2',
      });
      appendJSONL(eventFile, {
        seq: 4,
        target: 'architect',
        message: 'msg3',
      });
    });

    it('should consume messages from offset', async () => {
      mockQueueManager.getOffset.mockResolvedValue(0);

      const result = await manager.consume('claude-code:abc123');

      expect(result.consumed).toHaveLength(3); // seq 1, 2 (broadcast), 4 (nickname)
      expect(result.consumed[0].seq).toBe(1);
      expect(result.consumed[1].seq).toBe(2);
      expect(result.consumed[2].seq).toBe(4);
      expect(result.newOffset).toBe(4);
    });

    it('should skip already consumed messages', async () => {
      mockQueueManager.getOffset.mockResolvedValue(2);

      const result = await manager.consume('claude-code:abc123');

      expect(result.consumed).toHaveLength(1); // Only seq 4
      expect(result.consumed[0].seq).toBe(4);
    });

    it('should consume from beginning if requested', async () => {
      mockQueueManager.getOffset.mockResolvedValue(10);

      const result = await manager.consume('claude-code:abc123', true);

      expect(result.consumed).toHaveLength(3);
      expect(result.consumed[0].seq).toBe(1);
    });

    it('should update offset after consuming', async () => {
      mockQueueManager.getOffset.mockResolvedValue(0);

      await manager.consume('claude-code:abc123');

      expect(mockQueueManager.setOffset).toHaveBeenCalledWith('claude-code:abc123', 4);
    });

    it('should not update offset if no messages consumed', async () => {
      mockQueueManager.getOffset.mockResolvedValue(10);

      await manager.consume('claude-code:abc123');

      expect(mockQueueManager.setOffset).not.toHaveBeenCalled();
    });

    it('should handle multiple event files', async () => {
      appendJSONL(path.join(eventsDir, '2026-01-02.jsonl'), {
        seq: 5,
        target: 'claude-code:abc123',
        message: 'next-day',
      });

      mockQueueManager.getOffset.mockResolvedValue(0);

      const result = await manager.consume('claude-code:abc123');

      expect(result.consumed).toHaveLength(4);
      expect(result.newOffset).toBe(5);
    });

    it('should handle empty events directory', async () => {
      fs.rmSync(eventsDir, { recursive: true, force: true });

      const result = await manager.consume('claude-code:abc123');

      expect(result.consumed).toEqual([]);
      expect(result.newOffset).toBe(0);
    });
  });

  describe('resolve', () => {
    it('should return single candidate', async () => {
      const result = await manager.resolve('codex:xyz789', 'claude-code');

      expect(result.single).toBe('claude-code:abc123');
      expect(result.candidates).toHaveLength(1);
    });

    it('should return multiple candidates', async () => {
      busData.subscribers['codex:new123'] = {
        agent_type: 'codex',
        nickname: 'codex-2',
        status: 'active',
      };

      const result = await manager.resolve('claude-code:abc123', 'codex');

      expect(result.single).toBeNull();
      expect(result.candidates).toHaveLength(2);
    });

    it('should exclude self from candidates', async () => {
      const result = await manager.resolve('claude-code:abc123', 'claude-code');

      expect(result.candidates).toHaveLength(0);
    });

    it('should filter out inactive subscribers', async () => {
      const result = await manager.resolve('claude-code:abc123', 'codex');

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].id).toBe('codex:xyz789');
    });

    it('should support "claude" alias for "claude-code"', async () => {
      const result = await manager.resolve('codex:xyz789', 'claude');

      expect(result.single).toBe('claude-code:abc123');
    });

    it('should include candidate metadata', async () => {
      const result = await manager.resolve('codex:xyz789', 'claude-code');

      expect(result.candidates[0]).toMatchObject({
        id: 'claude-code:abc123',
        nickname: 'architect',
        agent_type: 'claude-code',
      });
      expect(result.candidates[0].last_seen).toBeDefined();
    });

    it('should return empty candidates for unknown type', async () => {
      const result = await manager.resolve('claude-code:abc123', 'unknown-type');

      expect(result.single).toBeNull();
      expect(result.candidates).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid sequential sends', async () => {
      const results = [];
      // Send messages sequentially (more realistic for actual usage)
      for (let i = 0; i < 10; i++) {
        results.push(await manager.send('architect', `Message ${i}`, 'sender'));
      }

      const seqs = results.map(r => r.seq);
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(10); // All should be unique
      expect(Math.max(...seqs)).toBe(10); // Should reach seq 10
    });

    it('should handle messages with complex data', async () => {
      const complexMessage = {
        text: 'Test',
        metadata: {
          nested: { deep: 'value' },
          array: [1, 2, 3],
        },
      };

      await manager.send('architect', JSON.stringify(complexMessage), 'sender');

      const files = fs.readdirSync(eventsDir);
      expect(files.length).toBe(1);
    });

    it('should handle subscribers with no nickname', async () => {
      busData.subscribers['test:123'] = {
        agent_type: 'test',
        status: 'active',
      };

      const result = await manager.resolve('claude-code:abc123', 'test');

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].nickname).toBeUndefined();
    });

    it('should handle empty subscribers object', async () => {
      const emptyBusData = {};
      const emptyManager = new MessageManager(testBusDir, emptyBusData, mockQueueManager);

      const targets = emptyManager.resolveTarget('*');
      expect(targets).toEqual([]);
    });
  });
});
