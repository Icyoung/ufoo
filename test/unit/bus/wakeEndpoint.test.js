"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertHttpsWakeUrl,
  markWakeAccepted,
  hasWakeAccepted,
  readWakeEndpoint,
  removeWakeEndpoint,
  wakeSubscriber,
  writeWakeEndpoint,
} = require("../../../src/coordination/bus/wakeEndpoint");

describe("wake endpoint", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-wake-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("accepts https and loopback http, rejects credentials and remote http", () => {
    expect(assertHttpsWakeUrl("https://example.com/hook")).toBe("https://example.com/hook");
    expect(assertHttpsWakeUrl("http://127.0.0.1:9/hook")).toBe("http://127.0.0.1:9/hook");
    expect(assertHttpsWakeUrl("http://[::1]:9/hook")).toBe("http://[::1]:9/hook");
    expect(() => assertHttpsWakeUrl("http://example.com/hook")).toThrow(/https/);
    expect(() => assertHttpsWakeUrl("https://user:secret@example.com/hook")).toThrow(/credentials/);
  });

  test("stores the endpoint at mode 600 and keeps the key out of the wake body", async () => {
    writeWakeEndpoint(projectRoot, "grok-bot:abc", {
      adapter: "bearer-json",
      url: "https://example.com/hook",
      key: "sender-secret",
    });
    const file = path.join(projectRoot, ".ufoo", "agent", "wake-endpoints.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stored = readWakeEndpoint(projectRoot, "grok-bot:abc");
    expect(stored.key).toBe("sender-secret");

    let body = "";
    let headers = {};
    const result = await wakeSubscriber(stored, {
      source: "ufoo",
      message: "hello",
    }, async (_url, init) => {
      body = init.body;
      headers = init.headers;
      return { status: 200 };
    });

    expect(result).toEqual({ accepted: true, status: 200 });
    expect(headers.authorization).toBe("Bearer sender-secret");
    expect(body).not.toContain("sender-secret");
    expect(JSON.parse(body).message).toBe("hello");
  });

  test("wake requests have a deadline even when a fetch implementation ignores cancellation", async () => {
    jest.useFakeTimers();
    let signal;
    try {
      const pending = wakeSubscriber({ adapter: "bearer-json", url: "https://example.test/hook", key: "test-key" }, {},
        (_url, init) => { signal = init.signal; expect(init.redirect).toBe("error"); return new Promise(() => {}); }, { timeoutMs: 10 });
      const result = expect(pending).rejects.toMatchObject({ code: "WAKE_TIMEOUT" });
      await jest.advanceTimersByTimeAsync(10);
      await result;
      expect(signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  test("concurrent registrations preserve every endpoint", async () => {
    const { execFile } = require("child_process");
    const modulePath = require.resolve("../../../src/coordination/bus/wakeEndpoint");
    const script = `const fs=require('fs');const original=fs.writeFileSync;
      fs.writeFileSync=function(file,...args){if(String(file).includes('wake-endpoints.json'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);return original.call(fs,file,...args)};
      require(process.argv[1]).writeWakeEndpoint(process.argv[2],process.argv[3],{url:'https://example.test/hook',key:'fixture-key'});`;
    await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      execFile(process.execPath, ["-e", script, modulePath, projectRoot, `grok-bot:${index}`], error => error ? reject(error) : resolve());
    })));
    for (let index = 0; index < 6; index++) expect(readWakeEndpoint(projectRoot, `grok-bot:${index}`)).toMatchObject({ key: "fixture-key" });
  });

  test("a non-200 response is not accepted and receipts survive only accepted seqs", async () => {
    const endpoint = {
      adapter: "bearer-json",
      url: "http://localhost/hook",
      key: "k",
    };
    await expect(wakeSubscriber(endpoint, { message: "x" }, async () => ({ status: 500 })))
      .resolves.toEqual({ accepted: false, status: 500 });

    writeWakeEndpoint(projectRoot, "grok-bot:abc", endpoint);
    markWakeAccepted(projectRoot, "grok-bot:abc", 7);
    expect(hasWakeAccepted(projectRoot, "grok-bot:abc", 7)).toBe(true);
    expect(hasWakeAccepted(projectRoot, "grok-bot:abc", 8)).toBe(false);
    removeWakeEndpoint(projectRoot, "grok-bot:abc");
    expect(readWakeEndpoint(projectRoot, "grok-bot:abc")).toBeNull();
    expect(hasWakeAccepted(projectRoot, "grok-bot:abc", 7)).toBe(false);
  });
});
