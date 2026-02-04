/**
 * 昵称管理和解析
 */
class NicknameManager {
  constructor(busData) {
    this.busData = busData;
  }

  /**
   * 解析昵称到订阅者 ID
   * @param {string} nickname - 昵称
   * @returns {string|null} - 订阅者 ID 或 null
   */
  resolveNickname(nickname) {
    const subscribers = this.busData.subscribers || {};
    for (const [id, meta] of Object.entries(subscribers)) {
      if (meta.nickname === nickname) {
        return id;
      }
    }
    return null;
  }

  /**
   * 检查昵称是否已存在
   * @param {string} nickname - 昵称
   * @param {string} excludeSubscriber - 排除的订阅者 ID（用于重命名时）
   * @returns {boolean} - 是否已存在
   */
  nicknameExists(nickname, excludeSubscriber = null) {
    const subscribers = this.busData.subscribers || {};
    for (const [id, meta] of Object.entries(subscribers)) {
      if (id !== excludeSubscriber && meta.nickname === nickname) {
        return true;
      }
    }
    return false;
  }

  /**
   * 生成自动昵称
   * @param {string} agentType - 代理类型（codex, claude-code）
   * @returns {string} - 自动生成的昵称（如 codex-1, claude-1）
   */
  generateAutoNickname(agentType) {
    const subscribers = this.busData.subscribers || {};
    const prefix = agentType === "claude-code" ? "claude" : agentType;

    // 找出所有相同前缀的昵称
    const existing = Object.values(subscribers)
      .map((meta) => meta.nickname)
      .filter((nick) => nick && nick.startsWith(`${prefix}-`))
      .map((nick) => {
        const match = nick.match(/^[^-]+-(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => !isNaN(n));

    // 找到下一个可用的编号
    const maxNumber = existing.length > 0 ? Math.max(...existing) : 0;
    return `${prefix}-${maxNumber + 1}`;
  }

  /**
   * 获取订阅者的昵称
   */
  getNickname(subscriber) {
    const meta = this.busData.subscribers?.[subscriber];
    return meta?.nickname || null;
  }

  /**
   * 设置订阅者的昵称
   */
  setNickname(subscriber, nickname) {
    if (!this.busData.subscribers) {
      this.busData.subscribers = {};
    }
    if (!this.busData.subscribers[subscriber]) {
      this.busData.subscribers[subscriber] = {};
    }
    this.busData.subscribers[subscriber].nickname = nickname;
  }
}

module.exports = NicknameManager;
