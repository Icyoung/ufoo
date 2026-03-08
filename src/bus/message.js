const fs = require("fs");
const path = require("path");
const {
  getTimestamp,
  getDate,
  readJSONL,
  appendJSONL,
  readLastLine,
  isPidAlive,
  normalizeAgentTypeAlias,
} = require("./utils");
const NicknameManager = require("./nickname");

const SEQ_LOCK_TIMEOUT_MS = 5000;
const SEQ_LOCK_POLL_MS = 25;
const SEQ_LOCK_STALE_MS = 30000;

/**
 * 消息管理器
 */
class MessageManager {
  constructor(busDir, busData, queueManager) {
    this.busDir = busDir;
    this.busData = busData;
    this.queueManager = queueManager;
    this.eventsDir = path.join(busDir, "events");
    this.seqFile = path.join(busDir, "seq.counter");
    this.seqLockFile = path.join(busDir, "seq.counter.lock");
  }

  /**
   * 从 events 日志中恢复最大序号（仅用于 counter 缺失时）
   */
  readMaxSeqFromEvents() {
    let maxSeq = 0;
    if (!fs.existsSync(this.eventsDir)) {
      return maxSeq;
    }

    const files = fs.readdirSync(this.eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse(); // 从最新的文件开始读

    for (const file of files) {
      const filePath = path.join(this.eventsDir, file);
      const lastLine = readLastLine(filePath);

      if (lastLine) {
        try {
          const event = JSON.parse(lastLine);
          if (event.seq && event.seq > maxSeq) {
            maxSeq = event.seq;
            break; // 找到最大 seq 后立即退出
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    return maxSeq;
  }

  readSeqCounter() {
    try {
      const raw = fs.readFileSync(this.seqFile, "utf8").trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    } catch {
      // ignore
    }
    return 0;
  }

  writeSeqCounter(seq) {
    fs.mkdirSync(path.dirname(this.seqFile), { recursive: true });
    fs.writeFileSync(this.seqFile, `${seq}\n`, "utf8");
  }

  cleanupStaleSeqLock() {
    if (!fs.existsSync(this.seqLockFile)) return;
    let shouldRemove = false;

    try {
      const raw = fs.readFileSync(this.seqLockFile, "utf8").trim();
      const pid = parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        shouldRemove = true;
      } else if (!isPidAlive(pid)) {
        shouldRemove = true;
      }
    } catch {
      shouldRemove = true;
    }

    if (!shouldRemove) {
      try {
        const stat = fs.statSync(this.seqLockFile);
        if (Date.now() - stat.mtimeMs > SEQ_LOCK_STALE_MS) {
          shouldRemove = true;
        }
      } catch {
        shouldRemove = true;
      }
    }

    if (shouldRemove) {
      try {
        fs.unlinkSync(this.seqLockFile);
      } catch {
        // ignore stale lock cleanup errors
      }
    }
  }

  async acquireSeqLock() {
    const deadline = Date.now() + SEQ_LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(this.seqLockFile, "wx");
        fs.writeSync(fd, `${process.pid}\n`);
        return fd;
      } catch (err) {
        if (err && err.code === "EEXIST") {
          this.cleanupStaleSeqLock();
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, SEQ_LOCK_POLL_MS));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Failed to acquire sequence lock");
  }

  releaseSeqLock(lockFd) {
    try {
      if (typeof lockFd === "number") {
        fs.closeSync(lockFd);
      }
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(this.seqLockFile)) {
        fs.unlinkSync(this.seqLockFile);
      }
    } catch {
      // ignore
    }
  }

  /**
   * 获取下一个全局序号（文件锁保证跨进程原子递增）
   */
  async getNextSeq() {
    const lockFd = await this.acquireSeqLock();
    try {
      let current = this.readSeqCounter();
      if (current === 0) {
        current = this.readMaxSeqFromEvents();
      }
      const next = current + 1;
      this.writeSeqCounter(next);
      return next;
    } finally {
      this.releaseSeqLock(lockFd);
    }
  }

  /**
   * 解析目标（支持昵称、代理类型、订阅者 ID）
   */
  resolveTarget(target) {
    const nicknameManager = new NicknameManager(this.busData);
    const normalizedTarget = normalizeAgentTypeAlias(target);

    // 0. Exact subscriber ID match (allows ids without ":" e.g. "ufoo-agent")
    const subscribers = this.busData.agents || {};
    if (target && typeof target === "string" && subscribers[target]) {
      return [target];
    }

    // 1. 尝试作为订阅者 ID
    if (target.includes(":")) {
      return [target];
    }

    // 2. 尝试作为昵称
    const byNickname = nicknameManager.resolveNickname(target);
    if (byNickname) {
      return [byNickname];
    }

    // 3. 尝试作为代理类型（匹配所有该类型的订阅者）
    const isActive = (meta) => !meta || meta.status === "active";

    const byType = Object.entries(subscribers)
      .filter(([, meta]) => normalizeAgentTypeAlias(meta.agent_type) === normalizedTarget && isActive(meta))
      .map(([id]) => id);

    if (byType.length > 0) {
      return byType;
    }

    // 4. 通配符（所有活跃订阅者）
    if (target === "*") {
      return Object.entries(subscribers)
        .filter(([, meta]) => isActive(meta))
        .map(([id]) => id);
    }

    // 未找到目标
    return [];
  }

  /**
   * 检查目标是否匹配订阅者
   */
  targetMatches(target, subscriber) {
    const normalizedTarget = normalizeAgentTypeAlias(target);
    // 精确匹配
    if (target === subscriber) return true;

    // 代理类型匹配
    const meta = this.busData.agents?.[subscriber];
    if (meta && normalizedTarget === normalizeAgentTypeAlias(meta.agent_type)) return true;

    // 昵称匹配
    if (meta && target === meta.nickname) return true;

    // 通配符
    if (target === "*") return true;

    return false;
  }

  /**
   * 发送消息
   */
  async send(target, message, publisher = "unknown") {
    const seq = await this.getNextSeq();
    const timestamp = getTimestamp();
    const date = getDate();

    // 解析目标
    const targets = this.resolveTarget(target);
    if (targets.length === 0) {
      throw new Error(`Target "${target}" not found`);
    }

    // 构建事件
    const event = {
      seq,
      timestamp,
      type: "message/targeted",
      event: "message",
      publisher,
      target,
      data: { message },
    };

    // 写入事件日志
    const eventFile = path.join(this.eventsDir, `${date}.jsonl`);
    appendJSONL(eventFile, event);

    // 为每个目标订阅者添加到待处理队列
    for (const targetSubscriber of targets) {
      // 检查订阅者的 offset，如果已经消费过这个 seq，不再添加
      const offset = await this.queueManager.getOffset(targetSubscriber);
      if (seq > offset) {
        await this.queueManager.appendPending(targetSubscriber, event);
      }
    }

    return { seq, targets };
  }

  /**
   * 广播消息
   */
  async broadcast(message, publisher = "unknown") {
    return this.send("*", message, publisher);
  }

  /**
   * 发送系统事件（非消息）
   */
  async emit(target, eventName, data = {}, publisher = "unknown", type = "status/agent") {
    const seq = await this.getNextSeq();
    const timestamp = getTimestamp();
    const date = getDate();

    // 解析目标
    const targets = this.resolveTarget(target);
    if (targets.length === 0) {
      throw new Error(`Target "${target}" not found`);
    }

    const event = {
      seq,
      timestamp,
      type,
      event: eventName,
      publisher,
      target,
      data,
    };

    const eventFile = path.join(this.eventsDir, `${date}.jsonl`);
    appendJSONL(eventFile, event);

    for (const targetSubscriber of targets) {
      const offset = await this.queueManager.getOffset(targetSubscriber);
      if (seq > offset) {
        await this.queueManager.appendPending(targetSubscriber, event);
      }
    }

    return { seq, targets };
  }

  /**
   * 检查待处理消息
   */
  async check(subscriber) {
    const pending = await this.queueManager.readPending(subscriber);
    return pending;
  }

  /**
   * 确认消息（清空待处理队列）
   */
  async ack(subscriber) {
    const pending = await this.queueManager.readPending(subscriber);
    const count = pending.length;

    if (count > 0) {
      await this.queueManager.clearPending(subscriber);
    }

    return count;
  }

  /**
   * 消费事件（从 offset 开始）
   */
  async consume(subscriber, fromBeginning = false) {
    let offset = fromBeginning ? 0 : await this.queueManager.getOffset(subscriber);
    const consumed = [];

    // 读取所有事件文件
    if (!fs.existsSync(this.eventsDir)) {
      return { consumed, newOffset: offset };
    }

    const files = fs.readdirSync(this.eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort(); // 按日期排序

    for (const file of files) {
      const filePath = path.join(this.eventsDir, file);
      const events = readJSONL(filePath);

      for (const event of events) {
        if (event.seq <= offset) continue;

        // 检查是否针对此订阅者
        if (
          this.targetMatches(event.target, subscriber) ||
          event.target === "*"
        ) {
          consumed.push(event);
          offset = Math.max(offset, event.seq);
        }
      }
    }

    // 更新 offset
    if (consumed.length > 0) {
      await this.queueManager.setOffset(subscriber, offset);
    }

    return { consumed, newOffset: offset };
  }

  /**
   * 智能路由解析（找出所有匹配的候选者）
   */
  async resolve(myId, targetType) {
    const normalizedTargetType = normalizeAgentTypeAlias(targetType);
    const subscribers = this.busData.agents || {};
    const candidates = Object.entries(subscribers)
      .filter(([id, meta]) => {
        if (id === myId) return false; // 排除自己
        if (meta.status !== "active") return false;

        if (normalizeAgentTypeAlias(meta.agent_type) === normalizedTargetType) return true;

        return false;
      })
      .map(([id, meta]) => ({
        id,
        nickname: meta.nickname,
        agent_type: meta.agent_type,
        last_seen: meta.last_seen,
      }));

    // 如果只有一个候选者，直接返回
    if (candidates.length === 1) {
      return { single: candidates[0].id, candidates };
    }

    // 多个候选者，返回列表供调用者选择
    return { single: null, candidates };
  }
}

module.exports = MessageManager;
