const fs = require("fs");
const os = require("os");
const path = require("path");
const { DeliveryQueue, QUEUE_TYPES, normalizeQueueEnvelope } = require("../../../src/coordination/bus/deliveryQueue");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJsonl(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    events.length > 0 ? `${events.map((evt) => JSON.stringify(evt)).join("\n")}\n` : "",
    "utf8"
  );
}

describe("DeliveryQueue", () => {
  let tmpDir;
  let pendingFile;
  let queue;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-delivery-queue-"));
    pendingFile = path.join(tmpDir, "queues", "codex_a", "pending.jsonl");
    queue = new DeliveryQueue(pendingFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("claimNext claims first event and leaves remaining pending", () => {
    writeJsonl(pendingFile, [
      { seq: 1, data: { message: "first" } },
      { seq: 2, data: { message: "second" } },
    ]);

    const claim = queue.claimNext();

    expect(claim.event.seq).toBe(1);
    expect(fs.existsSync(claim.processingFile)).toBe(true);
    expect(readJsonl(pendingFile)).toEqual([
      { seq: 2, data: { message: "second" } },
    ]);
  });

  test("claimNext can claim multiple events before completing without recovering active claims", () => {
    writeJsonl(pendingFile, [
      { seq: 1, data: { message: "first" } },
      { seq: 2, data: { message: "second" } },
    ]);

    const first = queue.claimNext();
    const second = queue.claimNext();
    const third = queue.claimNext();

    expect(first.event.seq).toBe(1);
    expect(second.event.seq).toBe(2);
    expect(third).toBeNull();
    expect(fs.existsSync(first.processingFile)).toBe(true);
    expect(fs.existsSync(second.processingFile)).toBe(true);

    queue.completeClaim(first);
    queue.completeClaim(second);
  });

  test("completeClaim removes processing file", () => {
    writeJsonl(pendingFile, [{ seq: 1, data: { message: "first" } }]);

    const claim = queue.claimNext();
    const completed = queue.completeClaim(claim);

    expect(completed).toBe(true);
    expect(fs.existsSync(claim.processingFile)).toBe(false);
    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  test("restoreClaim returns claimed event before remaining pending", () => {
    writeJsonl(pendingFile, [
      { seq: 1, data: { message: "first" } },
      { seq: 2, data: { message: "second" } },
    ]);

    const claim = queue.claimNext();
    queue.restoreClaim(claim);

    expect(readJsonl(pendingFile).map((evt) => evt.seq)).toEqual([1, 2]);
    expect(fs.existsSync(claim.processingFile)).toBe(false);
  });

  test("recover merges processing files, dedupes seq, and sorts sequenced events", () => {
    const deadPid = 99999999;
    const oldTs = Date.now() - 60000;
    writeJsonl(pendingFile, [
      { seq: 3, data: { message: "third" } },
      { seq: 2, data: { message: "duplicate-second-pending" } },
    ]);
    writeJsonl(`${pendingFile}.processing.${deadPid}.${oldTs}.a`, [
      { seq: 2, data: { message: "second" } },
      { seq: 1, data: { message: "first" } },
    ]);
    fs.appendFileSync(`${pendingFile}.processing.${deadPid}.${oldTs}.b`, "not-json\n", "utf8");
    fs.appendFileSync(`${pendingFile}.processing.${deadPid}.${oldTs}.b`, `${JSON.stringify({ data: { message: "no seq" } })}\n`, "utf8");

    const result = queue.recover();

    expect(result.files).toHaveLength(2);
    expect(readJsonl(pendingFile)).toEqual([
      { seq: 1, data: { message: "first" } },
      { seq: 2, data: { message: "duplicate-second-pending" } },
      { seq: 3, data: { message: "third" } },
      { data: { message: "no seq" } },
    ]);
    expect(fs.existsSync(`${pendingFile}.processing.${deadPid}.${oldTs}.a`)).toBe(false);
    expect(fs.existsSync(`${pendingFile}.processing.${deadPid}.${oldTs}.b`)).toBe(false);
  });

  test("recover does not merge active processing files", () => {
    writeJsonl(pendingFile, [{ seq: 2, data: { message: "second" } }]);
    const activeProcessingFile = `${pendingFile}.processing.${process.pid}.${Date.now()}.active`;
    writeJsonl(activeProcessingFile, [{ seq: 1, data: { message: "first" } }]);

    const result = queue.recover();

    expect(result.files).toEqual([]);
    expect(readJsonl(pendingFile).map((evt) => evt.seq)).toEqual([2]);
    expect(fs.existsSync(activeProcessingFile)).toBe(true);
  });

  test("recover does not merge old processing files while owner pid is alive", () => {
    const oldTs = Date.now() - 60000;
    const activeProcessingFile = `${pendingFile}.processing.${process.pid}.${oldTs}.active`;
    writeJsonl(activeProcessingFile, [{ seq: 1, data: { message: "first" } }]);

    const result = queue.recover();

    expect(result.files).toEqual([]);
    expect(fs.existsSync(activeProcessingFile)).toBe(true);
    expect(queue.claimNext()).toBeNull();
  });

  test("forSubscriber builds queue path from bus dir and subscriber id", () => {
    const bySubscriber = DeliveryQueue.forSubscriber(tmpDir, "claude-code:abc");
    expect(bySubscriber.pendingFile).toBe(path.join(tmpDir, "queues", "claude-code_abc", "pending.jsonl"));
  });

  test("append normalizes queue envelope metadata compatibly", () => {
    queue.append({
      seq: 1,
      event: "message",
      data: { message: "hello" },
    });

    const [event] = readJsonl(pendingFile);
    expect(event).toEqual(expect.objectContaining({
      seq: 1,
      event: "message",
      queue_type: QUEUE_TYPES.AGENT_MESSAGE,
      delivery: expect.objectContaining({ mode: "inject", gate: "idle" }),
      ack: expect.objectContaining({ policy: "on_delivery" }),
    }));
    expect(event.data.message).toBe("hello");
  });

  test("normalizeQueueEnvelope classifies daemon control events", () => {
    expect(normalizeQueueEnvelope({
      event: "delivery",
      target: "ufoo-agent",
    })).toEqual(expect.objectContaining({
      queue_type: QUEUE_TYPES.DELIVERY_STATUS,
      delivery: expect.objectContaining({ mode: "daemon_consume", gate: "none" }),
      ack: expect.objectContaining({ policy: "on_consume" }),
    }));
  });
});
