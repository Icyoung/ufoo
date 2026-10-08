const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  withNativeReceipts, listNativeReceipts, resolveNativeReceipt, submissionId,
} = require("../../../src/coordination/bus/nativeReceipts");

describe("native delivery recovery", () => {
  let projectRoot;
  const subscriber = "codex:test";
  const request = { deliveryId: "codex:test:seq:1", command: "work" };
  beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-receipts-")); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  test("unknown responses block replay until explicit retry, then cache acceptance", async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ queued: true });
    const deliver = withNativeReceipts({ projectRoot, subscriber, send });
    await expect(deliver(request)).rejects.toThrow("response lost");
    await expect(deliver(request)).rejects.toMatchObject({ code: "native_outcome_unknown" });
    expect(send).toHaveBeenCalledTimes(1);
    const [receipt] = listNativeReceipts(projectRoot, subscriber);
    expect(receipt).toMatchObject({ state: "unknown", delivery_id: request.deliveryId });
    resolveNativeReceipt(projectRoot, subscriber, receipt.id, "retry");
    await expect(deliver(request)).resolves.toEqual({ queued: true });
    await expect(deliver(request)).resolves.toEqual({ queued: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].retryAuthorized).toBe(true);
    await expect(deliver({ ...request, command: "different" })).rejects.toThrow("different content");
  });

  test("operator acceptance suppresses retransmission, and live inflight work cannot be resolved", async () => {
    let finish;
    const send = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    const deliver = withNativeReceipts({ projectRoot, subscriber, send });
    const operation = deliver(request);
    await expect(deliver({ ...request, command: "different" })).rejects.toThrow("different content");
    expect(() => resolveNativeReceipt(projectRoot, subscriber, submissionId(request.deliveryId), "retry")).toThrow("still in flight");
    finish({ queued: true });
    await operation;
    const uncertainRequest = { ...request, deliveryId: "codex:test:seq:2" };
    const failed = withNativeReceipts({ projectRoot, subscriber, send: async () => { throw new Error("lost"); } });
    await expect(failed(uncertainRequest)).rejects.toThrow("lost");
    resolveNativeReceipt(projectRoot, subscriber, submissionId(uncertainRequest.deliveryId), "accepted");
    await expect(deliver(uncertainRequest)).resolves.toMatchObject({ resolved_by: "operator" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("receipt paths reject traversal and receipts are private", async () => {
    expect(() => listNativeReceipts(projectRoot, "../outside")).toThrow("Invalid subscriber");
    expect(() => resolveNativeReceipt(projectRoot, subscriber, "../outside", "retry")).toThrow("Invalid receipt");
    await withNativeReceipts({ projectRoot, subscriber, send: async () => ({ queued: true }) })(request);
    const file = path.join(projectRoot, ".ufoo/bus/queues/codex_test/native-receipts", `${submissionId(request.deliveryId)}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
