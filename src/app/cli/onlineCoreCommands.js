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
  const OnlineServer = require("../../online/server");
  const host = opts.host || "127.0.0.1";
  const port = Number.isFinite(opts.port) ? opts.port : parseInt(opts.port || "8787", 10);
  const idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs)
    ? opts.idleTimeoutMs
    : parseInt(opts.idleTimeoutMs || opts.idleTimeout || "30000", 10);
  const tokenFile = opts.tokenFile || undefined;
  const insecure = !!opts.insecure;
  const tlsCert = opts.tlsCert || null;
  const tlsKey = opts.tlsKey || null;
  const webAppDir = opts.webAppDir || opts.webDir || process.env.UFOO_ONLINE_WEB_DIR || null;

  const server = new OnlineServer({
    host,
    port,
    tokenFile,
    idleTimeoutMs,
    insecure,
    tlsCert,
    tlsKey,
    webAppDir,
  });

  const isTls = !!(tlsCert && tlsKey);
  const wsProto = isTls ? "wss" : "ws";
  const httpProto = isTls ? "https" : "http";

  await server.start();
  console.log(`ufoo-online relay listening on ${host}:${server.port}`);
  console.log(`  WebSocket: ${wsProto}://${host}:${server.port}/ufoo/online`);
  console.log(`  HTTP API:  ${httpProto}://${host}:${server.port}/ufoo/online/rooms`);
  console.log(`             ${httpProto}://${host}:${server.port}/ufoo/online/channels`);
  if (server.webAppDir) console.log(`  Web UI:    ${httpProto}://${host}:${server.port}/ (${server.webAppDir})`);
  if (server.insecure) console.log("  Auth: INSECURE mode (any token accepted)");
  if (isTls) console.log("  TLS: enabled");
}

async function runOnlineToken(subscriber, opts = {}) {
  if (!subscriber) {
    throw new Error("online token requires <subscriber>");
  }
  const { generateToken, setToken, defaultTokensPath } = require("../../online/tokens");
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
    const creator = String(opts.createdBy || opts.creator || opts.nickname || opts.subscriber || "").trim();
    const payload = {
      name: opts.name,
      type: opts.type,
      password: opts.password,
      created_by: creator || undefined,
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
    const creator = String(opts.createdBy || opts.creator || opts.nickname || opts.subscriber || "").trim();
    const payload = {
      name: opts.name,
      type: opts.type,
      created_by: creator || undefined,
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
  const OnlineConnect = require("../../online/bridge");
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
  const { send } = require("../../online/runner");
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
  const { checkInbox } = require("../../online/runner");
  if (!nickname || nickname.startsWith("--")) {
    throw new Error("online inbox requires <nickname>");
  }
  checkInbox(nickname, {
    clear: !!opts.clear,
    unread: !!opts.unread,
    room: opts.room || "",
    channel: opts.channel || "",
  });
}

async function runOnlineRemote(action, target = "", opts = {}) {
  const act = String(action || "status").trim().toLowerCase();
  const {
    defaultRemoteDir,
    loadOrCreateDeviceIdentity,
    loadRemoteConfig,
    saveRemoteConfig,
    listPairedClients,
    revokePairedClient,
  } = require("../../online/remoteStore");
  const { createRemoteRelayBridge, buildRemoteWebUrl } = require("../../ui/remoteRelayBridge");
  const { renderQrTerminal } = require("../../online/qrSvg");

  const remoteDir = opts.remoteDir || defaultRemoteDir();
  const asJson = Boolean(opts.json);

  if (act === "status") {
    const identity = await loadOrCreateDeviceIdentity(remoteDir);
    const config = loadRemoteConfig(remoteDir);
    const devices = listPairedClients(remoteDir, { includeRevoked: Boolean(opts.all) });
    const summary = {
      ok: true,
      enabled: config.enabled,
      relay_url: config.relay_url,
      web_base_url: config.web_base_url,
      allow_insecure_ws: config.allow_insecure_ws,
      device_id: identity.device_id,
      device_name: identity.device_name,
      fingerprint: identity.fingerprint,
      remote_dir: remoteDir,
      paired_count: devices.filter((d) => !d.revoked_at).length,
      devices: devices.map((d) => ({
        client_id: d.client_id,
        label: d.label,
        fingerprint: d.fingerprint,
        paired_at: d.paired_at,
        last_seen: d.last_seen,
        revoked_at: d.revoked_at || null,
      })),
    };
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    }
    console.log(`Remote Access: ${summary.enabled ? "enabled" : "disabled"}`);
    console.log(`  Device:      ${summary.device_name} (${summary.device_id})`);
    console.log(`  Remote URL:  ${buildRemoteWebUrl(summary.web_base_url, summary.device_id)}`);
    console.log(`  Fingerprint: ${summary.fingerprint}`);
    console.log(`  Relay URL:   ${summary.relay_url}`);
    if (summary.web_base_url) console.log(`  Web Base:    ${summary.web_base_url}`);
    console.log(`  Paired:      ${summary.paired_count} device(s)`);
    for (const d of summary.devices) {
      const stateTag = d.revoked_at ? "[revoked]" : "[active]";
      console.log(`    - ${d.client_id}  ${d.label}  (${d.fingerprint}) ${stateTag}`);
    }
    return summary;
  }

  if (act === "devices" || act === "list") {
    const identity = await loadOrCreateDeviceIdentity(remoteDir);
    const devices = listPairedClients(remoteDir, { includeRevoked: Boolean(opts.all) });
    const payload = { ok: true, device_id: identity.device_id, devices };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    if (devices.length === 0) {
      console.log("No paired remote devices.");
      return payload;
    }
    for (const d of devices) {
      const stateTag = d.revoked_at ? "revoked" : "active";
      console.log(`${d.client_id}  ${d.label}  [${stateTag}]  fp=${d.fingerprint}  last_seen=${d.last_seen}`);
    }
    return payload;
  }

  if (act === "enable" || act === "disable") {
    await loadOrCreateDeviceIdentity(remoteDir);
    const saved = saveRemoteConfig(remoteDir, {
      enabled: act === "enable",
      ...(opts.relay ? { relay_url: opts.relay } : {}),
      ...(opts.webUrl ? { web_base_url: opts.webUrl } : {}),
      ...(opts.token ? { auth_token: opts.token } : {}),
      ...(opts.allowInsecureWs !== undefined ? { allow_insecure_ws: Boolean(opts.allowInsecureWs) } : {}),
    });
    const out = { ok: true, ...saved };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else console.log(`Remote access ${act === "enable" ? "enabled" : "disabled"} (relay: ${saved.relay_url})`);
    return out;
  }

  if (act === "revoke") {
    const clientId = String(target || opts.clientId || "").trim();
    if (!clientId) {
      throw new Error("remote revoke requires <client-id>");
    }
    const result = revokePairedClient(remoteDir, clientId);
    if (!result.ok) {
      throw new Error(result.error || `Failed to revoke ${clientId}`);
    }
    const out = { ok: true, revoked: clientId, revoked_at: result.client.revoked_at };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else console.log(`Revoked remote device: ${clientId} (${result.client.label})`);
    return out;
  }

  if (act === "pair") {
    const prevCfg = loadRemoteConfig(remoteDir);
    const relayUrl = String(opts.relay || prevCfg.relay_url || "").trim();
    const webUrl = String(opts.webUrl || prevCfg.web_base_url || "").trim();
    const ttlSec = Number(opts.ttl || 300);
    const ttlMs = Number.isFinite(ttlSec) ? Math.max(10, Math.min(ttlSec, 900)) * 1000 : 300000;

    if (opts.relay || opts.webUrl || opts.token || opts.allowInsecureWs) {
      saveRemoteConfig(remoteDir, {
        enabled: true,
        ...(opts.relay ? { relay_url: relayUrl } : {}),
        ...(opts.webUrl ? { web_base_url: webUrl } : {}),
        ...(opts.token ? { auth_token: opts.token } : {}),
        ...(opts.allowInsecureWs ? { allow_insecure_ws: true } : {}),
      });
    }

    let pairedResolved = false;
    let resolvePaired = null;
    const pairedPromise = new Promise((resolve) => {
      resolvePaired = resolve;
    });
    const beforeIds = new Set(listPairedClients(remoteDir).map((d) => d.client_id));

    const bridge = createRemoteRelayBridge({
      remoteDir,
      onStatusChange: () => {
        if (pairedResolved) return;
        const current = listPairedClients(remoteDir);
        const newlyPaired = current.find((d) => !beforeIds.has(d.client_id));
        if (newlyPaired) {
          pairedResolved = true;
          resolvePaired(newlyPaired);
        }
      },
    });

    try {
      const ticket = await bridge.createPairing({ ttlMs, webBaseUrl: webUrl });
      if (asJson) {
        console.log(JSON.stringify(ticket, null, 2));
      } else {
        console.log("");
        console.log(renderQrTerminal(ticket.deep_url));
        console.log("");
        console.log(`Pairing Code: ${ticket.pair_code}`);
        console.log(`Device ID:    ${ticket.device_id} (${ticket.device_name})`);
        if (ticket.remote_url) console.log(`Remote URL:   ${ticket.remote_url}`);
        console.log(`Fingerprint:  ${ticket.fingerprint}`);
        console.log(`Relay URL:    ${ticket.relay_url}`);
        console.log(`Pair Link:    ${ticket.deep_url}`);
        console.log(`Expires At:   ${ticket.expires_at}`);
      }

      if (opts.wait !== false && !opts.noWait) {
        if (!asJson) console.log("\nWaiting for remote device to claim pairing code (Ctrl+C to cancel)...");
        const timeout = new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), ttlMs);
          if (t.unref) t.unref();
        });
        const onSigint = () => resolvePaired(null);
        process.once("SIGINT", onSigint);
        const claimed = await Promise.race([pairedPromise, timeout]);
        process.off("SIGINT", onSigint);
        if (claimed && !asJson) {
          console.log(`Paired remote device: ${claimed.label} (${claimed.client_id})`);
        }
      }
      return ticket;
    } finally {
      await bridge.close();
    }
  }

  throw new Error(`Unknown remote action "${action}". Expected: status|pair|devices|revoke|enable|disable`);
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
          webAppDir: opts.webDir || null,
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
          createdBy: opts.createdBy || "",
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
          createdBy: opts.createdBy || "",
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
          room: opts.room || "",
          channel: opts.channel || "",
        });
      case "remote":
        return runOnlineRemote(payload.action, payload.target || "", {
          relay: opts.relay || opts.url || "",
          webUrl: opts.webUrl || "",
          token: opts.token || "",
          ttl: opts.ttl,
          allowInsecureWs: opts.allowInsecureWs,
          noWait: opts.noWait || opts.wait === false,
          all: opts.all,
          json: opts.json,
          remoteDir: opts.remoteDir || "",
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
        webAppDir: getFallbackOpt(argv, "--web-dir") || null,
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
        createdBy: getFallbackOpt(argv, "--created-by"),
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
        createdBy: getFallbackOpt(argv, "--created-by"),
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
        room: getFallbackOpt(argv, "--room"),
        channel: getFallbackOpt(argv, "--channel"),
      });
    }
    case "remote": {
      const action = argv[1] || "status";
      const target = argv[2] && !argv[2].startsWith("--") ? argv[2] : "";
      return runOnlineRemote(action, target, {
        relay: getFallbackOpt(argv, "--relay") || getFallbackOpt(argv, "--url"),
        webUrl: getFallbackOpt(argv, "--web-url"),
        token: getFallbackOpt(argv, "--token"),
        ttl: getFallbackOpt(argv, "--ttl") || undefined,
        allowInsecureWs: hasFallbackFlag(argv, "--allow-insecure-ws") ? true : undefined,
        noWait: hasFallbackFlag(argv, "--no-wait"),
        all: hasFallbackFlag(argv, "--all"),
        json: hasFallbackFlag(argv, "--json"),
        remoteDir: getFallbackOpt(argv, "--remote-dir"),
      });
    }
    default:
      throw createUnknownOnlineError(subcmd);
  }
}

module.exports = {
  runOnlineCommand,
  runOnlineRemote,
  createUnknownOnlineError,
};
