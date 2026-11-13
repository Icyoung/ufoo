"use strict";

const { getNativeTransport } = require("../../../../src/agents/providers/nativeTransport");
const originalFetch = global.fetch;
const resetError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) });
const success = () => new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
const run = (options = {}) => getNativeTransport("openai-chat").runTurn({
  url: "https://example.test/v1/chat/completions", model: "test", provider: "openai", messages: [], ...options,
});

beforeEach(() => { jest.useFakeTimers(); global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

test("retries transient connections with bounded backoff and identical request input", async () => {
  global.fetch.mockRejectedValueOnce(resetError()).mockRejectedValueOnce(resetError()).mockResolvedValueOnce(success());
  const phases = [];
  const pending = run({ onPhase: phase => phases.push(phase) });
  await jest.advanceTimersByTimeAsync(3000);
  await expect(pending).resolves.toMatchObject({ text: "done" });
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(new Set(global.fetch.mock.calls.map(([, init]) => init.body)).size).toBe(1);
  expect(phases.filter(phase => phase.type === "retry")).toEqual([
    expect.objectContaining({ attempt: 1, max_retries: 3, retry_delay_ms: 1000, code: "ECONNRESET" }),
    expect.objectContaining({ attempt: 2, max_retries: 3, retry_delay_ms: 2000, code: "ECONNRESET" }),
  ]);
});

test("honors Retry-After for rate limits", async () => {
  global.fetch.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "3" } })).mockResolvedValueOnce(success());
  const pending = run();
  await jest.advanceTimersByTimeAsync(2999);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ text: "done" });
});

test("does not retry authentication or certificate failures", async () => {
  global.fetch.mockResolvedValueOnce(new Response("denied", { status: 401 }));
  await expect(run()).rejects.toThrow("(401)");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  global.fetch.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }));
  await expect(run()).rejects.toMatchObject({ code: "CERT_HAS_EXPIRED" });
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("stops at three retries and retains the underlying network error", async () => {
  global.fetch.mockRejectedValue(resetError());
  const pending = expect(run()).rejects.toMatchObject({ code: "ECONNRESET" });
  await jest.advanceTimersByTimeAsync(7000);
  await pending;
  expect(global.fetch).toHaveBeenCalledTimes(4);
});

test("cancellation and the original deadline interrupt backoff", async () => {
  global.fetch.mockRejectedValue(resetError());
  const controller = new AbortController();
  const pending = run({ signal: controller.signal, onPhase: phase => { if (phase.type === "retry") controller.abort(); } });
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  const timed = expect(run({ timeoutMs: 1000 })).rejects.toMatchObject({ code: "timeout" });
  await jest.advanceTimersByTimeAsync(1000);
  await timed;
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("does not replay a stream after delivering partial output", async () => {
  let reads = 0;
  const cancel = jest.fn(async () => {});
  const releaseLock = jest.fn();
  global.fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "text/event-stream" }), body: {
    getReader: () => ({ read: async () => {
      if (reads++ === 0) return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n') };
      throw resetError();
    }, cancel, releaseLock }),
  } });
  const deltas = [];
  await expect(run({ onTextDelta: text => deltas.push(text) })).rejects.toMatchObject({ code: "ECONNRESET" });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(deltas).toEqual(["partial"]);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(releaseLock).toHaveBeenCalledTimes(1);
});

test("a non-settling stream cancellation cannot hold a completed request", async () => {
  const releaseLock = jest.fn();
  global.fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "text/event-stream" }), body: {
    getReader: () => ({ read: async () => ({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n') }),
      cancel: () => new Promise(() => {}), releaseLock }),
  } });
  await expect(run()).resolves.toMatchObject({ text: "done" });
  expect(releaseLock).toHaveBeenCalledTimes(1);
});
