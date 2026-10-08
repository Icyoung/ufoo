"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

/** Storage mechanism only: product fields, history hydration and GC are host codecs. */
function createSessionStore({
  namespace = "runtime", encode = (snapshot) => ({ ...snapshot }),
  toDisk = (snapshot) => snapshot, decode = (snapshot) => snapshot,
  prepareSave = () => {},
} = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(namespace)) throw new Error("invalid session namespace");
  const normalizeId = (id) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(String(id || "").trim()) ? String(id).trim() : "";
  const getDirectory = (root = process.cwd()) => path.join(path.resolve(root || process.cwd()), ".ufoo", "agent", namespace, "sessions");
  const getFilePath = (root, id) => normalizeId(id) ? path.join(getDirectory(root), `${normalizeId(id)}.json`) : "";
  return Object.freeze({
    getDirectory, getFilePath,
    save(root = process.cwd(), input = {}) {
      const workspaceRoot = path.resolve(root || process.cwd());
      let payload;
      let filePath = "";
      let temporary = "";
      try {
        payload = encode(input, { workspaceRoot });
        filePath = getFilePath(workspaceRoot, payload.sessionId);
        if (!filePath) return { ok: false, error: "invalid session id", sessionId: "", filePath: "" };
        const stored = toDisk(payload);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        prepareSave(workspaceRoot);
        temporary = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, filePath);
        return { ok: true, error: "", sessionId: payload.sessionId, filePath, snapshot: payload };
      } catch (error) {
        return { ok: false, error: error.message || "failed to save session", sessionId: payload && payload.sessionId || "", filePath };
      } finally {
        if (temporary && fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      }
    },
    load(root = process.cwd(), id = "") {
      const workspaceRoot = path.resolve(root || process.cwd());
      const sessionId = normalizeId(id);
      const filePath = getFilePath(workspaceRoot, sessionId);
      if (!sessionId) return { ok: false, error: "invalid session id", sessionId: "", snapshot: null, filePath: "" };
      if (!fs.existsSync(filePath)) return { ok: false, error: `session not found: ${sessionId}`, sessionId, snapshot: null, filePath };
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return { ok: true, error: "", sessionId, filePath, snapshot: decode(parsed, { workspaceRoot, sessionId }) };
      } catch (error) {
        return { ok: false, error: error.message || "failed to load session", sessionId, snapshot: null, filePath };
      }
    },
  });
}

module.exports = { createSessionStore };
