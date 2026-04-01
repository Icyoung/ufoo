"use strict";

/**
 * Claude Code session file utilities.
 *
 * Reads Claude Code's PID files (~/.claude/sessions/{pid}.json) and
 * transcript files (~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl)
 * to provide external status signals.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_CONFIG_DIR, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_CONFIG_DIR, "projects");

/**
 * Encode a CWD path to Claude Code's project directory name.
 * e.g. "/Users/icy/Code/ufoo" → "-Users-icy-Code-ufoo"
 */
function encodeProjectPath(cwd) {
  return String(cwd || "").replace(/\//g, "-");
}

/**
 * Read a Claude Code PID file.
 * Returns { pid, sessionId, cwd, startedAt, kind, entrypoint } or null.
 */
function readClaudePidFile(pid) {
  try {
    const filePath = path.join(SESSIONS_DIR, `${pid}.json`);
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Find the transcript JSONL file for a Claude Code session.
 * Returns the file path or "" if not found.
 */
function findTranscriptFile(cwd, sessionId) {
  if (!cwd || !sessionId) return "";
  const projectDir = path.join(PROJECTS_DIR, encodeProjectPath(cwd));
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(transcriptPath)) return transcriptPath;
  } catch {
    // ignore
  }
  return "";
}

/**
 * Get the mtime (in ms) of a Claude Code transcript file.
 * Returns 0 if the file doesn't exist or can't be read.
 */
function getTranscriptMtimeMs(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    const stat = fs.statSync(transcriptPath);
    return stat.mtimeMs || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if a Claude Code instance (by PID) is actively writing to its transcript.
 * Returns true if the transcript was modified within `thresholdMs` (default 5000ms).
 *
 * This is useful as a supplementary busy signal — when PTY output goes quiet
 * (e.g. during API wait), the transcript file is still being written to.
 */
function isTranscriptActive(pid, thresholdMs = 5000) {
  const pidData = readClaudePidFile(pid);
  if (!pidData || !pidData.sessionId || !pidData.cwd) return false;
  const transcriptPath = findTranscriptFile(pidData.cwd, pidData.sessionId);
  if (!transcriptPath) return false;
  const mtime = getTranscriptMtimeMs(transcriptPath);
  if (!mtime) return false;
  return (Date.now() - mtime) < thresholdMs;
}

/**
 * Find all live Claude Code sessions.
 * Returns array of { pid, sessionId, cwd, startedAt, kind, transcriptPath }.
 */
function listClaudeSessions() {
  const results = [];
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!/^\d+\.json$/.test(file)) continue;
      const pid = parseInt(file.slice(0, -5), 10);
      // Check if process is alive
      try {
        process.kill(pid, 0);
      } catch {
        continue; // dead process
      }
      const data = readClaudePidFile(pid);
      if (!data) continue;
      const transcriptPath = findTranscriptFile(data.cwd, data.sessionId);
      results.push({ ...data, pid, transcriptPath });
    }
  } catch {
    // ignore
  }
  return results;
}

module.exports = {
  encodeProjectPath,
  readClaudePidFile,
  findTranscriptFile,
  getTranscriptMtimeMs,
  isTranscriptActive,
  listClaudeSessions,
  SESSIONS_DIR,
  PROJECTS_DIR,
};
