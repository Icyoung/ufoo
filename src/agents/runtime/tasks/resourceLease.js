"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { withFileLock } = require("../context/fileLock");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

/** Cross-process serialization mechanism; the host supplies resource identity and policy. */
function createResourceLease({ file } = {}) {
  if (!file) throw new Error("resource lease file is required");
  function transaction(mutator) {
    return withFileLock(file, () => {
      const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, resources: {} };
      if (state.version !== 1 || !state.resources || typeof state.resources !== "object") throw new Error("invalid resource lease store");
      state.resources = Object.assign(Object.create(null), state.resources);
      for (const owner of Object.values(state.resources)) {
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string" || typeof owner.ownerId !== "string") throw new Error("invalid resource lease owner");
      }
      for (const [key, owner] of Object.entries(state.resources)) if (!alive(owner.pid)) delete state.resources[key];
      const result = mutator(state);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return result;
    });
  }
  const api = Object.freeze({
    acquire({ key, ownerId }) {
      if (!key || !ownerId) throw new Error("resource key and ownerId are required");
      return transaction((state) => {
        const existing = Object.prototype.hasOwnProperty.call(state.resources, key) ? state.resources[key] : null;
        if (existing) return existing.ownerId === ownerId && existing.pid === process.pid
          ? { ok: true, token: existing.token, reentrant: true }
          : { ok: false, code: "workspace_busy", ownerId: existing.ownerId };
        const token = randomUUID();
        state.resources[key] = { token, ownerId, pid: process.pid };
        return { ok: true, token, reentrant: false };
      });
    },
    release({ key, token }) {
      return transaction((state) => {
        if (!Object.prototype.hasOwnProperty.call(state.resources, key) || state.resources[key].token !== token) return false;
        delete state.resources[key]; return true;
      });
    },
    async run({ key, ownerId, signal, wait = false, timeoutMs = 600000 }, operation) {
      const started = Date.now();
      let lease;
      for (;;) {
        if (signal && signal.aborted) throw Object.assign(new Error("resource acquisition cancelled"), { code: "cancelled" });
        lease = api.acquire({ key, ownerId });
        if (lease.ok) break;
        if (!wait || Date.now() - started >= timeoutMs) return { ...lease, error: "workspace writer is active" };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      try { return await operation(); }
      finally { if (!lease.reentrant) api.release({ key, token: lease.token }); }
    },
  });
  return api;
}

module.exports = { createResourceLease };
