const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getUfooPaths } = require("../state/paths");
const { withFileLock } = require("../state/fileLock");
const { writeFileAtomic, subscriberToSafeName, isPidAlive } = require("./utils");

function submissionId(value) {
  const bytes = crypto.createHash("sha256").update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function receiptDirectory(projectRoot, subscriber) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(subscriber) || [".", ".."].includes(subscriber)) throw new Error("Invalid subscriber ID");
  return path.join(getUfooPaths(projectRoot).busQueuesDir, subscriberToSafeName(subscriber), "native-receipts");
}

function receiptFile(projectRoot, subscriber, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid receipt ID");
  return path.join(receiptDirectory(projectRoot, subscriber), `${id}.json`);
}

function readNativeReceipt(projectRoot, subscriber, deliveryId) {
  const file = receiptFile(projectRoot, subscriber, submissionId(deliveryId));
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function listNativeReceipts(projectRoot, subscriber) {
  const dir = receiptDirectory(projectRoot, subscriber);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

function writeReceipt(file, receipt) {
  writeFileAtomic(file, JSON.stringify({ ...receipt, updated_at: new Date().toISOString() }), { mode: 0o600 });
}

function resolveNativeReceipt(projectRoot, subscriber, id, resolution) {
  if (!["accepted", "retry"].includes(resolution)) throw new Error("Resolution must be accepted or retry");
  const file = receiptFile(projectRoot, subscriber, id);
  return withFileLock(file, () => {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!["unknown", "inflight"].includes(receipt.state)) throw new Error("Only uncertain receipts can be resolved");
    if (receipt.state === "inflight" && isPidAlive(receipt.owner_pid)) throw new Error("Delivery is still in flight; wait for its response");
    const next = { ...receipt, state: resolution === "accepted" ? "accepted" : "retry_allowed",
      resolution, resolved_at: new Date().toISOString(), result: resolution === "accepted" ? { queued: true, resolved_by: "operator" } : undefined };
    writeReceipt(file, next);
    return next;
  });
}

function withNativeReceipts({ projectRoot, subscriber, send }) {
  const dir = receiptDirectory(projectRoot, subscriber);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const inflight = new Map();
  return async (request) => {
    if (!request.deliveryId) throw Object.assign(new Error("Native delivery requires a stable delivery ID; use the updated daemon"), { code: "native_not_ready" });
    const deliveryId = String(request.deliveryId);
    const digest = crypto.createHash("sha256").update(request.command).digest("hex");
    if (inflight.has(deliveryId)) {
      const previous = inflight.get(deliveryId);
      if (previous.digest !== digest) throw Object.assign(new Error("Delivery ID was reused for different content"), { code: "native_not_ready" });
      return previous.operation;
    }
    const id = submissionId(deliveryId);
    const file = receiptFile(projectRoot, subscriber, id);
    const cached = withFileLock(file, () => {
      const receipt = readNativeReceipt(projectRoot, subscriber, deliveryId);
      if (receipt && receipt.digest !== digest) throw Object.assign(new Error("Delivery ID was reused for different content"), { code: "native_not_ready" });
      if (receipt?.state === "accepted") return receipt.result;
      if (receipt && receipt.state !== "retry_allowed") throw Object.assign(new Error(`Delivery outcome is unknown; inspect ufoo bus deliveries ${subscriber}`), { code: "native_outcome_unknown" });
      writeReceipt(file, { ...receipt, id, delivery_id: deliveryId, digest, state: "inflight", owner_pid: process.pid,
        retry_authorized: receipt?.state === "retry_allowed", attempt: (receipt?.attempt || 0) + 1 });
      return null;
    });
    if (cached) return cached;
    const operation = (async () => {
      try {
        const result = await send({ ...request, deliveryId, retryAuthorized: readNativeReceipt(projectRoot, subscriber, deliveryId)?.retry_authorized === true });
        withFileLock(file, () => writeReceipt(file, { ...readNativeReceipt(projectRoot, subscriber, deliveryId), id, delivery_id: deliveryId, digest, state: "accepted", result }));
        return result;
      } catch (error) {
        withFileLock(file, () => {
          if (error.remoteRejected || error.code === "native_not_ready") fs.rmSync(file, { force: true });
          else writeReceipt(file, { ...readNativeReceipt(projectRoot, subscriber, deliveryId), id, delivery_id: deliveryId, digest, state: "unknown", error: error.message });
        });
        throw error;
      } finally { inflight.delete(deliveryId); }
    })();
    inflight.set(deliveryId, { digest, operation });
    return operation;
  };
}

module.exports = { submissionId, readNativeReceipt, listNativeReceipts, resolveNativeReceipt, withNativeReceipts };
