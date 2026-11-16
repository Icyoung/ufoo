"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { resolveWorkspacePath } = require("../../../code/tools/common");

function validateWakeOptions(wake = {}, workspaceRoot) {
  if (!wake || typeof wake !== "object" || Array.isArray(wake)) throw new Error("wake must be an object");
  if (wake.onExit !== undefined && typeof wake.onExit !== "boolean") throw new Error("wake.onExit must be boolean");
  const conditions = wake.conditions || [];
  if (!Array.isArray(conditions) || conditions.length > 8) throw new Error("wake supports at most 8 conditions");
  for (const condition of conditions) {
    if (condition.type === "log_contains") {
      if (typeof condition.text !== "string" || !condition.text.length || Buffer.byteLength(condition.text) > 1024) throw new Error("log_contains requires 1..1024 bytes of literal text");
    } else if (condition.type === "file_exists") resolveWorkspacePath(workspaceRoot, condition.path);
    else if (condition.type === "port_open") {
      if (!Number.isInteger(condition.port) || condition.port < 1 || condition.port > 65535) throw new Error("port_open requires a port from 1 to 65535");
    } else throw new Error("unsupported background wake condition");
  }
  if (wake.timeoutMs !== undefined && (!Number.isInteger(wake.timeoutMs) || wake.timeoutMs < 100 || wake.timeoutMs > 43200000)) throw new Error("wake.timeoutMs must be 100..43200000");
  return { onExit: wake.onExit !== false, conditions, timeoutMs: wake.timeoutMs || 43200000 };
}

function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(200, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Bounded observation adapter; the shared runtime has no dependency on shell tools. */
function createBackgroundHookSource(workspaceRoot) {
  return { async check(sub) {
    const { backgroundId, onExit, conditions } = sub.spec;
    if (!/^bg_[a-zA-Z0-9_-]+$/.test(backgroundId)) throw new Error("invalid background identity");
    const base = path.join(workspaceRoot, ".ufoo", "agent", "bg", backgroundId);
    let record;
    try { record = JSON.parse(fs.readFileSync(`${base}.json`, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const cursor = { offset: 0, tail: "", matched: [], ...sub.cursor };
    const events = [];
    let log = "";
    let caughtUp = true;
    if (conditions.some((condition, index) => condition.type === "log_contains" && !cursor.matched.includes(index))) {
      let fd;
      try {
        fd = fs.openSync(`${base}.log`, "r");
        const size = fs.fstatSync(fd).size;
        if (size < cursor.offset) { cursor.offset = 0; cursor.tail = ""; }
        const buffer = Buffer.alloc(Math.min(65536, Math.max(0, size - cursor.offset)));
        const count = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
        cursor.offset += count;
        // Keep raw bytes across chunks so split UTF-8 and literal matches survive.
        const joined = Buffer.concat([Buffer.from(cursor.tail, "base64"), buffer.subarray(0, count)]);
        log = joined.toString("utf8");
        cursor.tail = joined.subarray(Math.max(0, joined.length - 1024)).toString("base64");
        caughtUp = cursor.offset >= size;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    for (let index = 0; index < conditions.length; index++) {
      if (cursor.matched.includes(index)) continue;
      const condition = conditions[index];
      let matched = false;
      if (condition.type === "log_contains") matched = log.includes(condition.text);
      if (condition.type === "file_exists") {
        try { matched = fs.existsSync(resolveWorkspacePath(workspaceRoot, condition.path).resolved); }
        catch { /* A path replaced with an escaping symlink is never a match. */ }
      }
      if (condition.type === "port_open") matched = await portOpen(condition.port);
      if (matched) {
        cursor.matched.push(index);
        events.push({ key: `condition-${index}`, type: "background.condition_matched", data: { backgroundId, condition, logPath: record.logPath } });
      }
    }
    let exited = record.status !== "running";
    if (!exited && record.pid) {
      try { process.kill(record.pid, 0); } catch (error) { exited = error.code === "ESRCH"; }
    }
    if (exited && caughtUp && onExit) events.push({ key: "exit", type: "background.exited", data: {
      backgroundId, exitCode: record.exitCode ?? null, signal: record.signal || "", status: record.status,
      outcomeKnown: record.exitCode != null || Boolean(record.signal), logPath: record.logPath,
      unmatchedConditions: conditions.filter((_, index) => !cursor.matched.includes(index)),
    } });
    return { cursor, events, done: (exited && caughtUp) || (!onExit && cursor.matched.length === conditions.length) };
  } };
}

module.exports = { createBackgroundHookSource, validateWakeOptions };
