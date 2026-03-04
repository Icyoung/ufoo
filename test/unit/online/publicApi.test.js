const OnlineServer = require("../../../src/online/server");
const WebSocket = require("ws");

function httpRequest({ method, url, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const data = body ? JSON.stringify(body) : null;
    const mergedHeaders = { "Content-Type": "application/json", ...headers };
    const req = http.request(url, { method, headers: mergedHeaders }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw || "{}") });
        } catch {
          resolve({ status: res.statusCode, data: {} });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve) => ws.once("open", resolve));
}

function createMessageQueue(ws) {
  const messages = [];
  let resolver = null;

  ws.on("message", (data) => {
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (resolver) {
      const next = resolver;
      resolver = null;
      next(msg);
    } else {
      messages.push(msg);
    }
  });

  return function nextMessage(timeoutMs = 3000) {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      resolver = resolve;
      setTimeout(() => {
        if (resolver === resolve) {
          resolver = null;
          reject(new Error("Timeout waiting for message"));
        }
      }, timeoutMs);
    });
  };
}

async function connectAuthedClient(port, token, { subscriberId, nickname }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
  const next = createMessageQueue(ws);
  await waitForOpen(ws);
  ws.send(JSON.stringify({
    type: "hello",
    client: { subscriber_id: subscriberId, nickname, world: "default" },
  }));
  await next(); // hello_ack
  await next(); // auth_required
  ws.send(JSON.stringify({ type: "auth", method: "token", token }));
  const auth = await next();
  expect(auth.type).toBe("auth_ok");
  return { ws, next };
}

describe("OnlineServer public preview APIs", () => {
  test("public metadata endpoints expose channel/room creator fields", async () => {
    const server = new OnlineServer({ host: "127.0.0.1", port: 0, tokens: ["t"] });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const authHeaders = { Authorization: "Bearer t" };

    await httpRequest({
      method: "POST",
      url: `${base}/ufoo/online/channels`,
      headers: authHeaders,
      body: { name: "world", type: "world", created_by: "ops-bot" },
    });
    await httpRequest({
      method: "POST",
      url: `${base}/ufoo/online/rooms`,
      headers: authHeaders,
      body: { name: "incident", type: "private", password: "secret", created_by: "claude-12" },
    });

    const channels = await httpRequest({ method: "GET", url: `${base}/ufoo/online/public/channels` });
    expect(channels.status).toBe(200);
    expect(channels.data.ok).toBe(true);
    expect(channels.data.channels.some((ch) => ch.name === "world" && ch.created_by === "ops-bot")).toBe(true);

    const rooms = await httpRequest({ method: "GET", url: `${base}/ufoo/online/public/rooms?type=private` });
    expect(rooms.status).toBe(200);
    expect(rooms.data.ok).toBe(true);
    expect(rooms.data.rooms.length).toBe(1);
    expect(rooms.data.rooms[0].created_by).toBe("claude-12");
    expect(rooms.data.rooms[0].password_required).toBe(true);
    expect(rooms.data.rooms[0].members).toBeUndefined();

    await server.stop();
  }, 15000);

  test("public channel messages endpoint returns persisted history", async () => {
    const server = new OnlineServer({ host: "127.0.0.1", port: 0, tokens: ["a", "b"] });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const created = await httpRequest({
      method: "POST",
      url: `${base}/ufoo/online/channels`,
      headers: { Authorization: "Bearer a" },
      body: { name: "release", type: "public", created_by: "release-bot" },
    });
    const channelId = created.data.channel.channel_id;

    const c1 = await connectAuthedClient(server.port, "a", {
      subscriberId: "codex:one",
      nickname: "codex-1",
    });
    const c2 = await connectAuthedClient(server.port, "b", {
      subscriberId: "claude:two",
      nickname: "claude-2",
    });

    c1.ws.send(JSON.stringify({ type: "join", channel: channelId }));
    c2.ws.send(JSON.stringify({ type: "join", channel: channelId }));
    await c1.next(); // join_ack
    await c2.next(); // join_ack

    c1.ws.send(JSON.stringify({
      type: "event",
      channel: channelId,
      payload: { kind: "message", message: "release smoke checks passed" },
    }));

    const delivered = await c2.next();
    expect(delivered.type).toBe("event");
    expect(delivered.payload.message).toBe("release smoke checks passed");

    const history = await httpRequest({
      method: "GET",
      url: `${base}/ufoo/online/public/channels/${encodeURIComponent(channelId)}/messages?limit=10`,
    });
    expect(history.status).toBe(200);
    expect(history.data.ok).toBe(true);
    expect(history.data.messages.length).toBe(1);
    expect(history.data.messages[0].text).toBe("release smoke checks passed");
    expect(history.data.messages[0].from).toBe("codex:one");
    expect(history.data.messages[0].nickname).toBe("codex-1");

    c1.ws.close();
    c2.ws.close();
    await Promise.all([
      new Promise((resolve) => c1.ws.once("close", resolve)),
      new Promise((resolve) => c2.ws.once("close", resolve)),
    ]);
    await server.stop();
  }, 20000);
});
