const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

/**
 * 决策管理器
 * 处理项目决策日志的读取、过滤和显示
 */
class DecisionsManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.contextDir = path.join(projectRoot, ".ufoo", "context");
    this.decisionsDir = DecisionsManager.resolveDecisionsDir(
      projectRoot,
      this.contextDir
    );
    this.indexFile = path.join(this.contextDir, "decisions.jsonl");
  }

  /**
   * 解析决策目录（优先小写 decisions，兼容旧 DECISIONS）
   */
  static resolveDecisionsDir(projectRoot, contextDir = null) {
    if (process.env.AI_CONTEXT_DECISIONS_DIR) {
      return process.env.AI_CONTEXT_DECISIONS_DIR;
    }
    const ctx = contextDir || path.join(projectRoot, ".ufoo", "context");
    const lower = path.join(ctx, "decisions");
    const upper = path.join(ctx, "DECISIONS");
    if (fs.existsSync(lower)) return lower;
    if (fs.existsSync(upper)) return upper;
    return lower;
  }

  /**
   * 读取所有决策文件
   */
  readDecisions() {
    if (!fs.existsSync(this.decisionsDir)) {
      return [];
    }

    const files = fs
      .readdirSync(this.decisionsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse(); // Newest first

    return files.map((file) => {
      const filePath = path.join(this.decisionsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      let data = {};
      let body = content;
      let title = "";

      try {
        const parsed = matter(content);
        data = parsed.data;
        body = parsed.content;

        // Extract title from first line of content
        const firstLine = body.trim().split("\n")[0];
        if (firstLine.startsWith("#")) {
          title = firstLine.replace(/^#+\s*/, "").trim();
        }
      } catch {
        // No frontmatter, extract title from first line
        const firstLine = content.trim().split("\n")[0];
        if (firstLine.startsWith("#")) {
          title = firstLine.replace(/^#+\s*/, "").trim();
        }
      }

      return {
        file,
        filePath,
        status: data.status || "open",
        title: title || "(no title)",
        content,
        data,
        body,
      };
    });
  }

  /**
   * 生成下一个 4 位编号
   */
  nextNumber() {
    if (!fs.existsSync(this.decisionsDir)) {
      return "0001";
    }
    const files = fs
      .readdirSync(this.decisionsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const match = f.match(/^(\d{4})-/);
        return match ? parseInt(match[1], 10) : 0;
      });
    const max = files.length ? Math.max(...files) : 0;
    return String(max + 1).padStart(4, "0");
  }

  /**
   * 简单 slugify
   */
  slugify(title) {
    const cleaned = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
    return cleaned || "decision";
  }

  /**
   * 创建新决策
   */
  createDecision(options = {}) {
    const title = (options.title || "").trim();
    if (!title) {
      throw new Error("Missing title. Usage: ufoo ctx decisions new \"Title\"");
    }

    const author =
      options.author ||
      process.env.UFOO_NICKNAME ||
      process.env.USER ||
      process.env.USERNAME ||
      "unknown";

    const nicknameRaw =
      options.nickname ||
      process.env.UFOO_NICKNAME ||
      process.env.USER ||
      process.env.USERNAME ||
      "unknown";

    const status = options.status || "open";
    const num = this.nextNumber();
    const slug = this.slugify(title);
    const nick = this.slugify(nicknameRaw);

    fs.mkdirSync(this.contextDir, { recursive: true });
    fs.mkdirSync(this.decisionsDir, { recursive: true });

    const file = `${num}-${nick}-${slug}.md`;
    const filePath = path.join(this.decisionsDir, file);
    const date = new Date().toISOString().slice(0, 10);

    const content =
      `---\n` +
      `status: ${status}\n` +
      `nickname: ${nicknameRaw}\n` +
      `---\n` +
      `# DECISION ${num}: ${title}\n\n` +
      `Date: ${date}\n` +
      `Author: ${author}\n` +
      `Nickname: ${nicknameRaw}\n\n` +
      `Context:\nWhat led to this decision?\n\n` +
      `Decision:\nWhat is now considered true?\n\n` +
      `Implications:\nWhat must follow from this?\n`;

    fs.writeFileSync(filePath, content, "utf8");
    console.log(`Created ${filePath}`);

    this.writeIndex();
    return { file, filePath };
  }

  /**
   * 从正文中提取字段（如 Date/Author）
   */
  extractField(body, fieldName) {
    const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, "mi");
    const match = body.match(regex);
    return match ? match[1].trim() : "";
  }

  /**
   * 规范化时间戳
   */
  normalizeTs(value, fallbackPath = null) {
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.valueOf())) {
        return parsed.toISOString();
      }
      return value;
    }
    if (fallbackPath && fs.existsSync(fallbackPath)) {
      const stat = fs.statSync(fallbackPath);
      return stat.mtime.toISOString();
    }
    return new Date().toISOString();
  }

  /**
   * 构建决策索引（jsonl）
   */
  buildIndexEntries(decisions) {
    const entries = [];

    for (const d of decisions) {
      const createdAt =
        d.data.created_at ||
        d.data.createdAt ||
        this.extractField(d.body, "Date");
      const author =
        d.data.author ||
        this.extractField(d.body, "Author") ||
        d.data.resolved_by ||
        d.data.resolvedBy ||
        "";

      entries.push({
        ts: this.normalizeTs(createdAt, d.filePath),
        type: "decision",
        file: d.file,
        author,
        status: d.status,
        title: d.title,
      });

      if (d.status && d.status !== "open") {
        const resolvedAt = d.data.resolved_at || d.data.resolvedAt;
        const resolvedBy = d.data.resolved_by || d.data.resolvedBy || author;
        entries.push({
          ts: this.normalizeTs(resolvedAt, d.filePath),
          type: "decision_status",
          file: d.file,
          author: resolvedBy,
          status: d.status,
          title: d.title,
        });
      }
    }

    return entries;
  }

  /**
   * 写入索引文件
   */
  writeIndex() {
    const decisions = this.readDecisions();
    const entries = this.buildIndexEntries(decisions);

    fs.mkdirSync(this.contextDir, { recursive: true });

    const lines = entries.map((e) => JSON.stringify(e));
    const output = lines.length ? `${lines.join("\n")}\n` : "";
    fs.writeFileSync(this.indexFile, output, "utf8");

    console.log(`Wrote ${entries.length} entries to ${this.indexFile}`);
  }

  /**
   * 过滤决策
   */
  filterDecisions(decisions, statusFilter = "open") {
    if (statusFilter === "all") {
      return decisions;
    }

    return decisions.filter((d) => d.status === statusFilter);
  }

  /**
   * 列出决策（简要模式）
   */
  list(options = {}) {
    const { status = "open" } = options;

    const decisions = this.readDecisions();
    const filtered = this.filterDecisions(decisions, status);

    console.log(
      `=== Decisions (${filtered.length} ${status}, ${decisions.length} total) ===`
    );

    for (const d of filtered) {
      console.log(`  [${d.status}] ${d.file}: ${d.title}`);
    }

    return filtered;
  }

  /**
   * 显示决策（完整内容）
   */
  show(options = {}) {
    const { status = "open", num = 1, all = false } = options;

    const decisions = this.readDecisions();
    const filtered = this.filterDecisions(decisions, status);

    if (filtered.length === 0) {
      if (decisions.length === 0) {
        console.log("No decisions found.");
      } else {
        console.log(`No decisions with status '${status}' found.`);
      }
      return [];
    }

    console.log(`=== Latest Decision(s) [${status}] ===`);
    console.log("");

    const count = all ? filtered.length : Math.min(num, filtered.length);

    for (let i = 0; i < count; i++) {
      const d = filtered[i];
      console.log(`--- ${d.file} [${d.status}] ---`);
      console.log(d.content);
      console.log("");
    }

    return filtered.slice(0, count);
  }
}

module.exports = DecisionsManager;
