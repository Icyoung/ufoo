const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { readJSON } = require("../bus/utils");
const { getUfooPaths } = require("../ufoo/paths");
const { resolveDisplayNickname } = require("../daemon/nicknameScope");
const {
  inspectDirectAuthStatus,
  formatDirectAuthStatus,
} = require("../agent/directAuthStatus");

function normalizeTty(ttyPath) {
  if (!ttyPath) return "";
  const trimmed = String(ttyPath).trim();
  if (!trimmed || trimmed === "not a tty") return "";
  if (trimmed === "/dev/tty") return "";
  return trimmed;
}

function tryTtyWithFd(fd) {
  try {
    const res = childProcess.spawnSync("tty", {
      stdio: [fd, "pipe", "ignore"],
      encoding: "utf8",
    });
    if (res && res.status === 0) {
      const tty = normalizeTty(res.stdout || "");
      if (tty) return tty;
    }
  } catch {
    // ignore
  }
  return "";
}

function detectCurrentTty() {
  const stdinTtyPath = normalizeTty(process.stdin?.ttyPath || "");
  if (stdinTtyPath) return stdinTtyPath;

  const fromStdin = tryTtyWithFd(0);
  if (fromStdin) return fromStdin;

  try {
    const fd = fs.openSync("/dev/tty", "r");
    const fromTty = tryTtyWithFd(fd);
    fs.closeSync(fd);
    if (fromTty) return fromTty;
  } catch {
    // ignore
  }

  return "";
}

/**
 * 显示项目状态
 */
class StatusDisplay {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot;
    this.paths = getUfooPaths(projectRoot);
    this.ufooDir = this.paths.ufooDir;
    this.inspectDirectAuthStatus = options.inspectDirectAuthStatus
      || options.inspectCodexDirectAuth
      || inspectDirectAuthStatus;
    this.formatDirectAuthStatus = options.formatDirectAuthStatus
      || options.formatCodexDirectAuthStatus
      || formatDirectAuthStatus;
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
    // 优先使用 UFOO_SUBSCRIBER_ID（daemon 启动的情况）
    if (process.env.UFOO_SUBSCRIBER_ID) {
      return process.env.UFOO_SUBSCRIBER_ID;
    }

    const agentsFile = this.paths.agentsFile;
    if (!fs.existsSync(agentsFile)) {
      return null;
    }

    // 尝试通过 tty 查找订阅者
    const currentTty = detectCurrentTty();

    if (currentTty && currentTty.startsWith("/dev/")) {
      const busData = readJSON(agentsFile);
      if (busData && busData.agents) {
        for (const [id, meta] of Object.entries(busData.agents)) {
          if (meta.tty === currentTty) {
            return id;
          }
        }
      }
    }

    return null;
  }

  /**
   * 统计未读消息
   */
  countUnreadMessages() {
    const queuesDir = this.paths.busQueuesDir;
    if (!fs.existsSync(queuesDir)) {
      return { total: 0, details: [] };
    }

    const agentsFile = this.paths.agentsFile;
    const busData = readJSON(agentsFile, {});

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
        if (busData.agents) {
          for (const [id, meta] of Object.entries(busData.agents)) {
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
    const agentsFile = this.paths.agentsFile;
    const busData = readJSON(agentsFile);
    if (!busData || !busData.agents) return null;
    const meta = busData.agents[subscriber];
    return meta ? resolveDisplayNickname(this.projectRoot, meta) : null;
  }

  /**
   * 显示横幅
   */
  showBanner(subscriber) {
    console.log("=== ufoo status ===");
    if (subscriber) {
      console.log(`Agent: ${subscriber}`);
    } else {
      console.log();
    }
  }

  async showDirectApiStatus() {
    const status = await this.inspectDirectAuthStatus({
      projectRoot: this.projectRoot,
      autoRefresh: false,
    });
    for (const line of this.formatDirectAuthStatus(status)) {
      console.log(line);
    }
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

    // 显示直连 API 凭证状态
    await this.showDirectApiStatus();

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
