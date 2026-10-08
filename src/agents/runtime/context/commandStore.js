"use strict";

const { createHash } = require("crypto");
const { stableStringify } = require("../core/stableJson");

/** Durable effect receipts. A missing receipt requires reconciliation, never replay. */
function createCommandStore(store) {
  const inFlight = new Map();
  return Object.freeze({
    execute({ commandId, kind, args }, operation) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(commandId || "")) throw new Error("safe commandId is required");
      const fingerprint = createHash("sha256").update(stableStringify({ kind, args })).digest("hex");
      const key = `${commandId}:${fingerprint}`;
      if (inFlight.has(key)) return inFlight.get(key);
      let previous = null;
      store.transaction((state) => {
        previous = Object.prototype.hasOwnProperty.call(state.commands, commandId) ? state.commands[commandId] : null;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw Object.assign(new Error("commandId reused with different content"), { code: "command_conflict" });
          return [];
        }
        return [{ type: "command.started", commandId, kind, fingerprint }];
      });
      if (previous) return Promise.resolve(previous.status === "resolved" ? previous.result
        : { ok: false, code: "uncertain_effect", commandId, error: "Effect has no durable receipt; reconcile before retrying." });
      const pending = Promise.resolve().then(operation).then((result) => {
        store.append({ type: "command.resolved", commandId, result });
        return result;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
    resolve(commandId, result) {
      return store.transaction((state) => {
        if (!Object.prototype.hasOwnProperty.call(state.commands, commandId)) throw new Error("command not found");
        if (state.commands[commandId].status === "resolved") throw new Error("command already resolved");
        return [{ type: "command.resolved", commandId, result }];
      });
    },
  });
}

module.exports = { createCommandStore };
