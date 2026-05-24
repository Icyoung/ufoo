const fs = require("fs");
const path = require("path");

/**
 * Sync log manager
 * Stores lightweight agent progress notes as JSONL.
 */
class SyncManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.contextDir = path.join(projectRoot, ".ufoo", "context");
    this.syncFile = path.join(this.contextDir, "sync.jsonl");
  }

  ensureContextDir() {
    fs.mkdirSync(this.contextDir, { recursive: true });
  }

  parseLines() {
    if (!fs.existsSync(this.syncFile)) return [];
    const raw = fs.readFileSync(this.syncFile, "utf8");
    if (!raw.trim()) return [];
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed legacy lines.
      }
    }
    return entries;
  }

  normalizeActor(value, fallback = "unknown") {
    const text = String(value || "").trim();
    if (text) return text;
    return fallback;
  }

  buildEntry(options = {}) {
    const message = String(options.message || "").trim();
    if (!message) {
      throw new Error(
        "Missing sync message. Usage: ufoo ctx sync write [--for <agent>] \"message\""
      );
    }

    return {
      ts: new Date().toISOString(),
      type: "sync",
      from: this.normalizeActor(
        options.from,
        process.env.UFOO_SUBSCRIBER_ID ||
          process.env.UFOO_NICKNAME ||
          process.env.USER ||
          process.env.USERNAME ||
          "unknown"
      ),
      for: this.normalizeActor(options.for, ""),
      message,
      decision: String(options.decision || "").trim(),
      file: String(options.file || "").trim(),
      tests: String(options.tests || "").trim(),
      verification: String(options.verification || "").trim(),
      risk: String(options.risk || "").trim(),
      next: String(options.next || "").trim(),
    };
  }

  write(options = {}) {
    const entry = this.buildEntry(options);
    this.ensureContextDir();
    fs.appendFileSync(this.syncFile, `${JSON.stringify(entry)}\n`, "utf8");
    console.log(this.formatEntry(entry));
    return entry;
  }

  formatEntry(entry) {
    const parts = [];
    parts.push("[sync]");
    if (entry.for) parts.push(`[for ${entry.for}]`);
    if (entry.from) parts.push(`[from ${entry.from}]`);
    parts.push(entry.message);

    if (entry.decision) parts.push(`decision: ${entry.decision}.`);
    if (entry.file) parts.push(`file: ${entry.file}.`);
    if (entry.tests) parts.push(`tests: ${entry.tests}.`);
    if (entry.verification) parts.push(`verification: ${entry.verification}.`);
    if (entry.risk) parts.push(`risk: ${entry.risk}.`);
    if (entry.next) parts.push(`next-cut: ${entry.next}.`);

    return parts.join(" ");
  }

  list(options = {}) {
    const num = Number.isFinite(options.num) && options.num > 0 ? options.num : 20;
    const filterFor = String(options.for || "").trim();
    const filterFrom = String(options.from || "").trim();

    let entries = this.parseLines();
    if (filterFor) entries = entries.filter((entry) => String(entry.for || "") === filterFor);
    if (filterFrom) entries = entries.filter((entry) => String(entry.from || "") === filterFrom);

    entries.sort((a, b) => {
      const left = new Date(a.ts || 0).getTime();
      const right = new Date(b.ts || 0).getTime();
      return right - left;
    });

    const shown = entries.slice(0, num);
    console.log(`=== Sync (${shown.length} shown, ${entries.length} matched) ===`);
    for (const entry of shown) {
      console.log(`${entry.ts || "-"} ${this.formatEntry(entry)}`);
    }
    if (shown.length === 0) {
      console.log("No sync entries found.");
    }
    return shown;
  }
}

module.exports = SyncManager;
