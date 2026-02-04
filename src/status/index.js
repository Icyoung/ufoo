const fs = require("fs");
const path = require("path");
const { readJSON } = require("../bus/utils");

/**
 * 显示项目状态
 */
class StatusDisplay {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.ufooDir = path.join(projectRoot, ".ufoo");
  }

  /**
   * 检查 .ufoo 目录是否存在
   */
  checkUfooDir() {
    if (!fs.existsSync(this.ufooDir)) {
      console.error("FAIL: .ufoo not found. Run: ufoo init");
      process.exit(1);
    }
  }

  /**
   * 获取当前订阅者信息
   */
  getCurrentSubscriber() {
    const busFile = path.join(this.ufooDir, "bus", "bus.json");
    if (!fs.existsSync(busFile)) {
      return null;
    }

    // 尝试通过 tty 查找订阅者
    let currentTty = null;
    try {
      currentTty = fs.readFileSync("/dev/tty", "utf8").trim();
    } catch {
      // tty 不可用
    }

    if (currentTty && currentTty.startsWith("/dev/")) {
      const busData = readJSON(busFile);
      if (busData && busData.subscribers) {
        for (const [id, meta] of Object.entries(busData.subscribers)) {
          if (meta.tty === currentTty) {
            return id;
          }
        }
      }
    }

    // 回退到环境变量
    const sessionId = process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID;
    if (sessionId) {
      const agentType = process.env.CODEX_SESSION_ID ? "codex" : "claude-code";
      return `${agentType}:${sessionId}`;
    }

    return null;
  }

  /**
   * 统计未读消息
   */
  countUnreadMessages() {
    const queuesDir = path.join(this.ufooDir, "bus", "queues");
    if (!fs.existsSync(queuesDir)) {
      return { total: 0, details: [] };
    }

    const busFile = path.join(this.ufooDir, "bus", "bus.json");
    const busData = readJSON(busFile, {});

    let total = 0;
    const details = [];

    const subscribers = fs.readdirSync(queuesDir);
    for (const safeName of subscribers) {
      const pendingFile = path.join(queuesDir, safeName, "pending.jsonl");
      if (!fs.existsSync(pendingFile)) {
        continue;
      }

      const stat = fs.statSync(pendingFile);
      if (stat.size === 0) {
        continue;
      }

      const content = fs.readFileSync(pendingFile, "utf8").trim();
      const count = content ? content.split("\n").length : 0;

      if (count > 0) {
        total += count;

        // 找到订阅者名称
        let subscriberName = safeName.replace(/_/, ":");
        if (busData.subscribers) {
          for (const [id, meta] of Object.entries(busData.subscribers)) {
            if (id.replace(/:/, "_") === safeName) {
              subscriberName = id;
              break;
            }
          }
        }

        details.push({ subscriber: subscriberName, count });
      }
    }

    return { total, details };
  }

  /**
   * 统计开放的决策
   */
  countOpenDecisions() {
    const DecisionsManager = require("../context/decisions");
    const manager = new DecisionsManager(this.projectRoot);
    const decisionsDir = manager.decisionsDir;
    if (!fs.existsSync(decisionsDir)) {
      return { total: 0, details: [] };
    }

    let total = 0;
    const details = [];

    const files = fs.readdirSync(decisionsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (const file of files) {
      const filePath = path.join(decisionsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      // 提取状态
      const status = this.extractStatus(content);
      if (status === "open") {
        total++;

        // 提取标题
        const title = this.extractTitle(content);
        details.push({ file, title: title || "(no title)" });
      }
    }

    return { total, details };
  }

  /**
   * 从决策文件提取状态
   */
  extractStatus(content) {
    const lines = content.split("\n");
    let inFrontmatter = false;
    let frontmatterCount = 0;

    for (const line of lines) {
      if (line.trim() === "---") {
        frontmatterCount++;
        if (frontmatterCount === 2) {
          break;
        }
        inFrontmatter = frontmatterCount === 1;
        continue;
      }

      if (inFrontmatter && line.startsWith("status:")) {
        return line.split(":")[1].trim();
      }
    }

    return "open";
  }

  /**
   * 从决策文件提取标题
   */
  extractTitle(content) {
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("#")) {
        return line.replace(/^#\s*/, "").trim();
      }
    }
    return null;
  }

  /**
   * 获取订阅者昵称（如果存在）
   */
  getSubscriberNickname(subscriber) {
    if (!subscriber) return null;
    const busFile = path.join(this.ufooDir, "bus", "bus.json");
    const busData = readJSON(busFile);
    if (!busData || !busData.subscribers) return null;
    const meta = busData.subscribers[subscriber];
    return meta && meta.nickname ? meta.nickname : null;
  }

  /**
   * 显示横幅（如果存在）
   */
  showBanner(subscriber) {
    if (!subscriber) {
      console.log("=== ufoo status ===");
      console.log();
      return;
    }

    const { showBanner } = require("../utils/banner");
    const agentType = subscriber.startsWith("codex:") ? "codex" : "claude";
    const sessionId = subscriber.split(":")[1] || "unknown";
    const nickname = this.getSubscriberNickname(subscriber);

    showBanner({ agentType, sessionId, nickname });
  }

  /**
   * 显示完整状态
   */
  async show() {
    this.checkUfooDir();

    const subscriber = this.getCurrentSubscriber();

    // 显示横幅
    this.showBanner(subscriber);

    // 显示项目路径
    console.log(`Project: ${this.projectRoot}`);

    // 显示未读消息
    const unread = this.countUnreadMessages();
    console.log(`Unread messages: ${unread.total}`);
    if (unread.details.length > 0) {
      for (const { subscriber: sub, count } of unread.details) {
        console.log(`  - ${sub}: ${count}`);
      }
    }

    // 显示开放的决策
    const decisions = this.countOpenDecisions();
    console.log(`Open decisions: ${decisions.total}`);
    if (decisions.details.length > 0) {
      for (const { file, title } of decisions.details) {
        console.log(`  - ${file}: ${title}`);
      }
    }
  }
}

module.exports = StatusDisplay;
