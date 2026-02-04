const NicknameManager = require('../../../src/bus/nickname');

describe('NicknameManager', () => {
  let busData;
  let manager;

  beforeEach(() => {
    busData = {
      subscribers: {
        'claude-code:abc123': { nickname: 'architect', status: 'active' },
        'claude-code:xyz789': { nickname: 'dev-lead', status: 'active' },
        'codex:def456': { nickname: 'codex-1', status: 'active' },
        'codex:ghi789': { nickname: 'codex-2', status: 'inactive' },
      },
    };
    manager = new NicknameManager(busData);
  });

  describe('resolveNickname', () => {
    it('should resolve existing nickname', () => {
      expect(manager.resolveNickname('architect')).toBe('claude-code:abc123');
      expect(manager.resolveNickname('dev-lead')).toBe('claude-code:xyz789');
      expect(manager.resolveNickname('codex-1')).toBe('codex:def456');
    });

    it('should return null for non-existent nickname', () => {
      expect(manager.resolveNickname('nonexistent')).toBeNull();
      expect(manager.resolveNickname('random')).toBeNull();
    });

    it('should handle empty nickname', () => {
      expect(manager.resolveNickname('')).toBeNull();
    });

    it('should handle undefined subscribers', () => {
      const emptyManager = new NicknameManager({});
      expect(emptyManager.resolveNickname('anything')).toBeNull();
    });
  });

  describe('nicknameExists', () => {
    it('should return true for existing nickname', () => {
      expect(manager.nicknameExists('architect')).toBe(true);
      expect(manager.nicknameExists('dev-lead')).toBe(true);
      expect(manager.nicknameExists('codex-1')).toBe(true);
    });

    it('should return false for non-existent nickname', () => {
      expect(manager.nicknameExists('nonexistent')).toBe(false);
      expect(manager.nicknameExists('new-nickname')).toBe(false);
    });

    it('should exclude specified subscriber', () => {
      // architect exists but should be excluded
      expect(manager.nicknameExists('architect', 'claude-code:abc123')).toBe(false);
      // but still exists for other subscribers
      expect(manager.nicknameExists('architect', 'codex:def456')).toBe(true);
    });

    it('should handle undefined subscribers', () => {
      const emptyManager = new NicknameManager({});
      expect(emptyManager.nicknameExists('anything')).toBe(false);
    });
  });

  describe('generateAutoNickname', () => {
    it('should generate sequential nickname for claude', () => {
      // Already have architect, dev-lead (not sequential)
      // Should generate claude-1 (first sequential one)
      expect(manager.generateAutoNickname('claude-code')).toBe('claude-1');
    });

    it('should generate sequential nickname for codex', () => {
      // Already have codex-1, codex-2
      // Should generate codex-3
      expect(manager.generateAutoNickname('codex')).toBe('codex-3');
    });

    it('should start from 1 for empty list', () => {
      const emptyManager = new NicknameManager({ subscribers: {} });
      expect(emptyManager.generateAutoNickname('claude-code')).toBe('claude-1');
      expect(emptyManager.generateAutoNickname('codex')).toBe('codex-1');
    });

    it('should find next available number', () => {
      // Add more codex agents
      busData.subscribers['codex:new1'] = { nickname: 'codex-3' };
      busData.subscribers['codex:new2'] = { nickname: 'codex-5' };
      busData.subscribers['codex:new3'] = { nickname: 'codex-10' };

      // Should generate codex-11 (max + 1)
      expect(manager.generateAutoNickname('codex')).toBe('codex-11');
    });

    it('should handle non-sequential nicknames', () => {
      busData.subscribers['claude-code:new'] = { nickname: 'random-name' };
      // Should still generate claude-1 (ignores non-sequential)
      expect(manager.generateAutoNickname('claude-code')).toBe('claude-1');
    });
  });

  describe('getNickname', () => {
    it('should return nickname for existing subscriber', () => {
      expect(manager.getNickname('claude-code:abc123')).toBe('architect');
      expect(manager.getNickname('codex:def456')).toBe('codex-1');
    });

    it('should return null for non-existent subscriber', () => {
      expect(manager.getNickname('nonexistent:123')).toBeNull();
    });

    it('should return null for subscriber without nickname', () => {
      busData.subscribers['test:123'] = { status: 'active' };
      expect(manager.getNickname('test:123')).toBeNull();
    });
  });

  describe('setNickname', () => {
    it('should set nickname for existing subscriber', () => {
      manager.setNickname('claude-code:abc123', 'new-name');
      expect(busData.subscribers['claude-code:abc123'].nickname).toBe('new-name');
    });

    it('should create subscriber entry if not exists', () => {
      manager.setNickname('new:123', 'test-name');
      expect(busData.subscribers['new:123'].nickname).toBe('test-name');
    });

    it('should initialize subscribers object if undefined', () => {
      const emptyManager = new NicknameManager({});
      emptyManager.setNickname('test:123', 'name');
      expect(emptyManager.busData.subscribers['test:123'].nickname).toBe('name');
    });

    it('should overwrite existing nickname', () => {
      manager.setNickname('claude-code:abc123', 'updated-name');
      expect(manager.getNickname('claude-code:abc123')).toBe('updated-name');
    });
  });

  describe('edge cases', () => {
    it('should handle empty busData', () => {
      const emptyManager = new NicknameManager({});
      expect(emptyManager.resolveNickname('test')).toBeNull();
      expect(emptyManager.nicknameExists('test')).toBe(false);
      expect(emptyManager.generateAutoNickname('claude-code')).toBe('claude-1');
    });

    it('should handle busData without subscribers', () => {
      const manager = new NicknameManager({ created_at: '2026-01-01' });
      expect(manager.resolveNickname('test')).toBeNull();
      expect(manager.nicknameExists('test')).toBe(false);
    });

    it('should handle special characters in nicknames', () => {
      busData.subscribers['test:123'] = { nickname: 'name-with-dash' };
      expect(manager.resolveNickname('name-with-dash')).toBe('test:123');
      expect(manager.nicknameExists('name-with-dash')).toBe(true);
    });

    it('should handle numeric nicknames', () => {
      busData.subscribers['test:123'] = { nickname: '12345' };
      expect(manager.resolveNickname('12345')).toBe('test:123');
    });
  });
});
