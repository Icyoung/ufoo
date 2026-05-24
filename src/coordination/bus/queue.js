const fs = require("fs");
const path = require("path");
const {
  subscriberToSafeName,
  ensureDir,
  readJSONL,
  appendJSONL,
  truncateFile,
} = require("./utils");

/**
 * 队列管理器
 */
class QueueManager {
  constructor(busDir) {
    this.busDir = busDir;
    this.queuesDir = path.join(busDir, "queues");
    this.offsetsDir = path.join(busDir, "offsets");
  }

  /**
   * 获取订阅者的队列目录
   */
  getQueueDir(subscriber) {
    const safeName = subscriberToSafeName(subscriber);
    return path.join(this.queuesDir, safeName);
  }

  /**
   * 确保队列目录存在
   */
  ensureQueueDir(subscriber) {
    const queueDir = this.getQueueDir(subscriber);
    ensureDir(queueDir);
    return queueDir;
  }

  /**
   * 获取 offset 文件路径
   */
  getOffsetPath(subscriber) {
    return path.join(this.offsetsDir, `${subscriberToSafeName(subscriber)}.offset`);
  }

  /**
   * 获取 pending 文件路径
   */
  getPendingPath(subscriber) {
    return path.join(this.getQueueDir(subscriber), "pending.jsonl");
  }

  /**
   * 获取 tty 文件路径
   */
  getTtyPath(subscriber) {
    return path.join(this.getQueueDir(subscriber), "tty");
  }

  /**
   * 读取 offset
   */
  async getOffset(subscriber) {
    const offsetPath = this.getOffsetPath(subscriber);
    if (!fs.existsSync(offsetPath)) {
      return 0;
    }
    const content = fs.readFileSync(offsetPath, "utf8").trim();
    return parseInt(content, 10) || 0;
  }

  /**
   * 设置 offset
   */
  async setOffset(subscriber, seq) {
    const offsetPath = this.getOffsetPath(subscriber);
    ensureDir(path.dirname(offsetPath));
    fs.writeFileSync(offsetPath, `${seq}\n`, "utf8");
  }

  /**
   * 读取待处理消息
   */
  async readPending(subscriber) {
    const pendingPath = this.getPendingPath(subscriber);
    return readJSONL(pendingPath);
  }

  /**
   * 追加待处理消息
   */
  async appendPending(subscriber, event) {
    this.ensureQueueDir(subscriber);
    const pendingPath = this.getPendingPath(subscriber);
    appendJSONL(pendingPath, event);
    if (event && event.event === "wake") {
      const wakePath = path.join(this.getQueueDir(subscriber), "wake");
      fs.writeFileSync(wakePath, String(event.seq || Date.now()), "utf8");
    }
  }

  /**
   * 清空待处理消息
   */
  async clearPending(subscriber) {
    const pendingPath = this.getPendingPath(subscriber);
    truncateFile(pendingPath);
  }

  /**
   * 检查是否有待处理消息
   */
  async hasPending(subscriber) {
    const pending = await this.readPending(subscriber);
    return pending.length > 0;
  }

  /**
   * 保存 tty 设备路径
   */
  async saveTty(subscriber, tty) {
    this.ensureQueueDir(subscriber);
    const ttyPath = this.getTtyPath(subscriber);
    fs.writeFileSync(ttyPath, tty, "utf8");
  }

  /**
   * 读取 tty 设备路径
   */
  async readTty(subscriber) {
    const ttyPath = this.getTtyPath(subscriber);
    if (!fs.existsSync(ttyPath)) return null;
    return fs.readFileSync(ttyPath, "utf8").trim();
  }
}

module.exports = QueueManager;
