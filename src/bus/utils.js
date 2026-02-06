const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * 获取当前 UTC 时间戳（ISO 8601 格式）
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * 获取当前日期（YYYY-MM-DD 格式）
 */
function getDate() {
  return new Date().toISOString().split("T")[0];
}

/**
 * 生成实例 ID（8 位十六进制）
 */
function generateInstanceId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * 将订阅者 ID 转换为安全的文件名
 * 例如：claude-code:abc123 -> claude-code_abc123
 */
function subscriberToSafeName(subscriber) {
  return subscriber.replace(/:/g, "_");
}

/**
 * 将安全文件名转换回订阅者 ID
 * 例如：claude-code_abc123 -> claude-code:abc123
 */
function safeNameToSubscriber(safeName) {
  // 只替换第一个下划线为冒号
  const match = safeName.match(/^([^_]+)_(.+)$/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  return safeName;
}

/**
 * 检查进程是否存活
 */
function isPidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Sandbox can return EPERM for other processes even if they are alive.
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

/**
 * 获取进程命令名（用于校验 PID 是否仍属于 agent 进程）
 */
function getPidCommand(pid) {
  if (!pid || pid === 0) return "";
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status === 0) {
      return (res.stdout || "").trim();
    }
  } catch {
    // ignore
  }
  return "";
}

/**
 * 判断 PID 是否为可识别的 agent 进程
 */
function isAgentPidAlive(pid) {
  if (!isPidAlive(pid)) return false;
  const cmd = getPidCommand(pid);
  if (!cmd) return true;
  return /(claude|codex|node)/i.test(cmd);
}

/**
 * 检查 tty 路径是否有效（用于注入）
 */
function isValidTty(ttyPath) {
  if (!ttyPath) return false;
  if (ttyPath === "/dev/tty") return false;
  if (!ttyPath.startsWith("/dev/")) return false;
  return true;
}

function normalizeTty(ttyPath) {
  if (!ttyPath) return "";
  const trimmed = String(ttyPath).trim();
  if (!trimmed || trimmed === "not a tty") return "";
  if (trimmed === "/dev/tty") return "";
  return trimmed;
}

function getCurrentTty() {
  try {
    const res = spawnSync("tty", {
      stdio: [0, "pipe", "ignore"],
      encoding: "utf8",
    });
    if (res && res.status === 0) {
      const tty = normalizeTty(res.stdout || "");
      return isValidTty(tty) ? tty : "";
    }
  } catch {
    // ignore
  }
  return "";
}

function parsePsLines(raw) {
  const lines = String(raw || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    return { pid: parseInt(match[1], 10), comm: match[2].trim() };
  }).filter(Boolean);
}

function getTtyProcessInfo(ttyPath) {
  if (!isValidTty(ttyPath)) {
    return { alive: false, idle: false, hasAgent: false, shellPid: 0, processes: [] };
  }
  const ttyName = ttyPath.replace("/dev/", "");
  try {
    const res = spawnSync("ps", ["-t", ttyName, "-o", "pid=,comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0) {
      return { alive: false, idle: false, hasAgent: false, shellPid: 0, processes: [] };
    }
    const processes = parsePsLines(res.stdout || "");
    if (processes.length === 0) {
      return { alive: false, idle: false, hasAgent: false, shellPid: 0, processes: [] };
    }
    const shellNames = new Set(["zsh", "bash", "fish", "sh", "login"]);
    const hasAgent = processes.some((p) => /(codex|claude|node)/i.test(p.comm));
    const nonShell = processes.filter((p) => !shellNames.has(p.comm));
    const idle = !hasAgent && nonShell.length === 0;
    const shell = processes.find((p) => shellNames.has(p.comm));
    return { alive: true, idle, hasAgent, shellPid: shell ? shell.pid : 0, processes };
  } catch {
    return { alive: false, idle: false, hasAgent: false, shellPid: 0, processes: [] };
  }
}

/**
 * 确保目录存在
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 原子性地追加内容到文件
 * @param {string} filePath - 文件路径
 * @param {string} content - 要追加的内容
 */
function appendFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, { encoding: "utf8", flag: "a" });
}

/**
 * 原子性地写入文件
 */
function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmpFile = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, filePath);
}

/**
 * 读取 JSON 文件
 */
function readJSON(filePath, defaultValue = null) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    return defaultValue;
  }
}

/**
 * 写入 JSON 文件（格式化）
 */
function writeJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  writeFileAtomic(filePath, content);
}

/**
 * 读取 JSONL 文件的所有行
 */
function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * 追加一行到 JSONL 文件
 */
function appendJSONL(filePath, data) {
  const line = JSON.stringify(data);
  appendFileAtomic(filePath, `${line}\n`);
}

/**
 * 读取文件的最后一行
 */
function readLastLine(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return null;
  const lines = content.split("\n");
  return lines[lines.length - 1];
}

/**
 * 清空文件内容
 */
function truncateFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf8");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 日志输出（带颜色）
 */
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[0;33m",
  blue: "\x1b[0;34m",
  cyan: "\x1b[0;36m",
};

function logInfo(message) {
  console.log(`${colors.blue}[bus]${colors.reset} ${message}`);
}

function logOk(message) {
  console.log(`${colors.green}[bus]${colors.reset} ${message}`);
}

function logWarn(message) {
  console.log(`${colors.yellow}[bus]${colors.reset} ${message}`);
}

function logError(message) {
  console.error(`${colors.red}[bus]${colors.reset} ${message}`);
}

module.exports = {
  getTimestamp,
  getDate,
  generateInstanceId,
  subscriberToSafeName,
  safeNameToSubscriber,
  isPidAlive,
  getPidCommand,
  isAgentPidAlive,
  isValidTty,
  getCurrentTty,
  getTtyProcessInfo,
  ensureDir,
  appendFileAtomic,
  writeFileAtomic,
  readJSON,
  writeJSON,
  readJSONL,
  appendJSONL,
  readLastLine,
  truncateFile,
  sleep,
  logInfo,
  logOk,
  logWarn,
  logError,
  colors,
};
