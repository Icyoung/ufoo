"use strict";

function createUnknownOnlineError(subcmd) {
  const err = new Error(`Unknown online subcommand: ${subcmd}`);
  err.code = "UFOO_ONLINE_UNKNOWN";
  return err;
}

function getFallbackOpt(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return "";
  return argv[idx + 1] || "";
}

function hasFallbackFlag(argv, name) {
  return argv.includes(name);
}

function buildAuthHeaders(onlineAuthHeaders, opts) {
  if (typeof onlineAuthHeaders === "function") {
    return onlineAuthHeaders(opts);
  }
  return {};
}

async function runOnlineServer(opts = {}) {
  const OnlineServer = require("../online/server");
  const host = opts.host || "127.0.0.1";
  const port = Number.isFinite(opts.port) ? opts.port : parseInt(opts.port || "8787", 10);
  const idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs)
    ? opts.idleTimeoutMs
    : parseInt(opts.idleTimeoutMs || opts.idleTimeout || "30000", 10);
  const tokenFile = opts.tokenFile || undefined;
  const insecure = !!opts.insecure;
  const tlsCert = opts.tlsCert || null;
  const tlsKey = opts.tlsKey || null;

  const server = new OnlineServer({
    host,
    port,
    tokenFile,
    idleTimeoutMs,
    insecure,
    tlsCert,
    tlsKey,
  });

  const isTls = !!(tlsCert && tlsKey);
  const wsProto = isTls ? "wss" : "ws";
  const httpProto = isTls ? "https" : "http";

  await server.start();
  console.log(`ufoo-online relay listening on ${host}:${server.port}`);
  console.log(`  WebSocket: ${wsProto}://${host}:${server.port}/ufoo/online`);
  console.log(`  HTTP API:  ${httpProto}://${host}:${server.port}/ufoo/online/rooms`);
  console.log(`             ${httpProto}://${host}:${server.port}/ufoo/online/channels`);
  if (server.insecure) console.log("  Auth: INSECURE mode (any token accepted)");
  if (isTls) console.log("  TLS: enabled");
}

async function runOnlineToken(subscriber, opts = {}) {
  if (!subscriber) {
    throw new Error("online token requires <subscriber>");
  }
  const { generateToken, setToken, defaultTokensPath } = require("../online/tokens");
  const filePath = opts.file || defaultTokensPath();
  const token = generateToken();
  const entry = setToken(filePath, subscriber, token, opts.server || "https://online.ufoo.dev", {
    nickname: opts.nickname || "",
  });
  console.log(JSON.stringify({
    subscriber,
    token,
    token_hash: entry.token_hash,
    server: entry.server,
    nickname: entry.nickname,
    file: filePath,
  }, null, 2));
}

async function runOnlineRoom(action, opts = {}, onlineAuthHeaders) {
  const base = opts.server || "https://online.ufoo.dev";
  const endpoint = `${base.replace(/\/$/, "")}/ufoo/online/rooms`;
  const authHeaders = buildAuthHeaders(onlineAuthHeaders, {
    authToken: opts.authToken,
    tokenFile: opts.tokenFile,
    subscriber: opts.subscriber,
    nickname: opts.nickname,
  });

  if (action === "list") {
    const res = await fetch(endpoint, { headers: { ...authHeaders } });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "create") {
    const payload = {
      name: opts.name,
      type: opts.type,
      password: opts.password,
    };
    if (!payload.type) {
      throw new Error("online room create requires --type");
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("online room requires action create|list");
}

async function runOnlineChannel(action, opts = {}, onlineAuthHeaders) {
  const base = opts.server || "https://online.ufoo.dev";
  const endpoint = `${base.replace(/\/$/, "")}/ufoo/online/channels`;
  const authHeaders = buildAuthHeaders(onlineAuthHeaders, {
    authToken: opts.authToken,
    tokenFile: opts.tokenFile,
    subscriber: opts.subscriber,
    nickname: opts.nickname,
  });

  if (action === "list") {
    const res = await fetch(endpoint, { headers: { ...authHeaders } });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (action === "create") {
    const payload = {
      name: opts.name,
      type: opts.type,
    };
    if (!payload.name) {
      throw new Error("online channel create requires --name");
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  throw new Error("online channel requires action create|list");
}

async function runOnlineConnect(opts = {}) {
  if (!opts.nickname) {
    throw new Error("online connect requires --nickname");
  }
  const OnlineConnect = require("../online/bridge");
  const conn = new OnlineConnect({
    projectRoot: opts.projectRoot || process.cwd(),
    nickname: opts.nickname,
    subscriberId: opts.subscriber || "",
    url: opts.url || "wss://online.ufoo.dev/ufoo/online",
    token: opts.token || "",
    tokenHash: opts.tokenHash || "",
    tokenFile: opts.tokenFile || "",
    world: opts.world || "default",
    pingMs: opts.pingMs ? parseInt(opts.pingMs, 10) : 0,
    channel: opts.join || "",
    room: opts.room || "",
    roomPassword: opts.roomPassword || "",
    pollIntervalMs: opts.interval ? parseInt(opts.interval, 10) : 1500,
    allowInsecureWs: !!opts.allowInsecureWs,
    trustRemote: !!opts.trustRemote,
    allowFrom: opts.allowFrom || [],
  });
  await conn.start();
}

function runOnlineSend(opts = {}) {
  const { send } = require("../online/runner");
  if (!opts.nickname || !opts.text) {
    throw new Error("online send requires --nickname and --text");
  }
  send(opts.nickname, {
    text: opts.text,
    channel: opts.channel || "",
    room: opts.room || "",
  });
}

function runOnlineInbox(nickname, opts = {}) {
  const { checkInbox } = require("../online/runner");
  if (!nickname || nickname.startsWith("--")) {
    throw new Error("online inbox requires <nickname>");
  }
  checkInbox(nickname, {
    clear: !!opts.clear,
    unread: !!opts.unread,
  });
}

async function runOnlineCommand(subcmd, payload = {}, options = {}) {
  const mode = options.mode || "commander";
  const onlineAuthHeaders = options.onlineAuthHeaders;

  if (mode === "commander") {
    const opts = payload.opts || {};
    switch (subcmd) {
      case "server":
        return runOnlineServer({
          host: opts.host,
          port: parseInt(opts.port, 10),
          tokenFile: opts.tokenFile || undefined,
          idleTimeoutMs: parseInt(opts.idleTimeout, 10),
          insecure: opts.insecure || false,
          tlsCert: opts.tlsCert || null,
          tlsKey: opts.tlsKey || null,
        });
      case "token":
        return runOnlineToken(payload.subscriber, {
          nickname: opts.nickname || "",
          server: opts.server || "https://online.ufoo.dev",
          file: opts.file || "",
        });
      case "room":
        return runOnlineRoom(payload.action, {
          server: opts.server || "https://online.ufoo.dev",
          authToken: opts.authToken || "",
          tokenFile: opts.tokenFile || "",
          subscriber: opts.subscriber || "",
          nickname: opts.nickname || "",
          name: opts.name,
          type: opts.type,
          password: opts.password,
        }, onlineAuthHeaders);
      case "channel":
        return runOnlineChannel(payload.action, {
          server: opts.server || "https://online.ufoo.dev",
          authToken: opts.authToken || "",
          tokenFile: opts.tokenFile || "",
          subscriber: opts.subscriber || "",
          nickname: opts.nickname || "",
          name: opts.name,
          type: opts.type,
        }, onlineAuthHeaders);
      case "connect":
        return runOnlineConnect({
          projectRoot: options.projectRoot || process.cwd(),
          nickname: opts.nickname,
          subscriber: opts.subscriber || "",
          url: opts.url,
          token: opts.token || "",
          tokenHash: opts.tokenHash || "",
          tokenFile: opts.tokenFile || "",
          world: opts.world,
          pingMs: opts.pingMs,
          join: opts.join || "",
          room: opts.room || "",
          roomPassword: opts.roomPassword || "",
          interval: opts.interval,
          allowInsecureWs: opts.allowInsecureWs,
          trustRemote: opts.trustRemote,
          allowFrom: opts.allowFrom || [],
        });
      case "send":
        return runOnlineSend({
          nickname: opts.nickname,
          text: opts.text,
          channel: opts.channel || "",
          room: opts.room || "",
        });
      case "inbox":
        return runOnlineInbox(payload.nickname, {
          clear: opts.clear,
          unread: opts.unread,
        });
      default:
        throw createUnknownOnlineError(subcmd);
    }
  }

  const argv = payload.argv || [];
  switch (subcmd) {
    case "server": {
      return runOnlineServer({
        host: getFallbackOpt(argv, "--host") || "127.0.0.1",
        port: parseInt(getFallbackOpt(argv, "--port") || "8787", 10),
        tokenFile: getFallbackOpt(argv, "--token-file") || undefined,
        idleTimeoutMs: parseInt(getFallbackOpt(argv, "--idle-timeout") || "30000", 10),
        insecure: hasFallbackFlag(argv, "--insecure"),
        tlsCert: getFallbackOpt(argv, "--tls-cert") || null,
        tlsKey: getFallbackOpt(argv, "--tls-key") || null,
      });
    }
    case "token": {
      const subscriber = argv[1];
      return runOnlineToken(subscriber, {
        nickname: getFallbackOpt(argv, "--nickname"),
        server: getFallbackOpt(argv, "--server") || "https://online.ufoo.dev",
        file: getFallbackOpt(argv, "--file"),
      });
    }
    case "room": {
      const action = argv[1] || "";
      return runOnlineRoom(action, {
        server: getFallbackOpt(argv, "--server") || "https://online.ufoo.dev",
        authToken: getFallbackOpt(argv, "--auth-token"),
        tokenFile: getFallbackOpt(argv, "--token-file"),
        subscriber: getFallbackOpt(argv, "--subscriber"),
        nickname: getFallbackOpt(argv, "--nickname"),
        name: getFallbackOpt(argv, "--name"),
        type: getFallbackOpt(argv, "--type"),
        password: getFallbackOpt(argv, "--password"),
      }, onlineAuthHeaders);
    }
    case "channel": {
      const action = argv[1] || "";
      const defaultChannelType = options.defaultChannelType || "public";
      return runOnlineChannel(action, {
        server: getFallbackOpt(argv, "--server") || "https://online.ufoo.dev",
        authToken: getFallbackOpt(argv, "--auth-token"),
        tokenFile: getFallbackOpt(argv, "--token-file"),
        subscriber: getFallbackOpt(argv, "--subscriber"),
        nickname: getFallbackOpt(argv, "--nickname"),
        name: getFallbackOpt(argv, "--name"),
        type: getFallbackOpt(argv, "--type") || defaultChannelType,
      }, onlineAuthHeaders);
    }
    case "connect": {
      const allowFrom = (() => {
        const collectOptionValues = options.collectOptionValues;
        const collectOption = options.collectOption;
        if (typeof collectOptionValues !== "function" || typeof collectOption !== "function") return [];
        return collectOptionValues(argv, "--allow-from")
          .reduce((acc, value) => collectOption(value, acc), []);
      })();
      return runOnlineConnect({
        projectRoot: options.projectRoot || process.cwd(),
        nickname: getFallbackOpt(argv, "--nickname"),
        subscriber: getFallbackOpt(argv, "--subscriber"),
        url: getFallbackOpt(argv, "--url") || "wss://online.ufoo.dev/ufoo/online",
        token: getFallbackOpt(argv, "--token"),
        tokenHash: getFallbackOpt(argv, "--token-hash"),
        tokenFile: getFallbackOpt(argv, "--token-file"),
        world: getFallbackOpt(argv, "--world") || "default",
        pingMs: getFallbackOpt(argv, "--ping-ms") ? parseInt(getFallbackOpt(argv, "--ping-ms"), 10) : 0,
        join: getFallbackOpt(argv, "--join"),
        room: getFallbackOpt(argv, "--room"),
        roomPassword: getFallbackOpt(argv, "--room-password"),
        interval: getFallbackOpt(argv, "--interval") ? parseInt(getFallbackOpt(argv, "--interval"), 10) : 1500,
        allowInsecureWs: hasFallbackFlag(argv, "--allow-insecure-ws"),
        trustRemote: hasFallbackFlag(argv, "--trust-remote"),
        allowFrom,
      });
    }
    case "send": {
      return runOnlineSend({
        nickname: getFallbackOpt(argv, "--nickname"),
        text: getFallbackOpt(argv, "--text"),
        channel: getFallbackOpt(argv, "--channel"),
        room: getFallbackOpt(argv, "--room"),
      });
    }
    case "inbox": {
      return runOnlineInbox(argv[1], {
        clear: hasFallbackFlag(argv, "--clear"),
        unread: hasFallbackFlag(argv, "--unread"),
      });
    }
    default:
      throw createUnknownOnlineError(subcmd);
  }
}

module.exports = {
  runOnlineCommand,
  createUnknownOnlineError,
};
