"use strict";

const { readWakeKeyFile } = require("../../coordination/bus/wakeEndpoint");

function parseJoinArgs(cmdArgs = []) {
  const positionals = [];
  let wakeUrl = "";
  let wakeKeyFile = "";
  let wakeAdapter = "";

  for (let index = 0; index < cmdArgs.length; index += 1) {
    const arg = String(cmdArgs[index] || "");
    if (arg === "--wake-url") {
      wakeUrl = String(cmdArgs[index + 1] || "").trim();
      if (!wakeUrl || wakeUrl.startsWith("--")) throw new Error("join --wake-url requires <url>");
      index += 1;
      continue;
    }
    if (arg === "--wake-key-file") {
      wakeKeyFile = String(cmdArgs[index + 1] || "").trim();
      if (!wakeKeyFile || wakeKeyFile.startsWith("--")) throw new Error("join --wake-key-file requires <path>");
      index += 1;
      continue;
    }
    if (arg === "--wake-adapter") {
      wakeAdapter = String(cmdArgs[index + 1] || "").trim();
      if (!wakeAdapter || wakeAdapter.startsWith("--")) throw new Error("join --wake-adapter requires <name>");
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown join option: ${arg}`);
    positionals.push(arg);
  }

  if ((positionals[1] || "").toLowerCase() === "grok-bot") positionals[1] = "grok-bot";
  const wakeRequested = Boolean(wakeUrl || wakeKeyFile || wakeAdapter);
  if (wakeRequested && !positionals[1]) {
    throw new Error("join wake requires <agent-type>");
  }
  if (wakeRequested && (!wakeUrl || !wakeKeyFile)) {
    throw new Error("join wake requires --wake-url and --wake-key-file");
  }
  if (positionals[1] === "grok-bot" && !wakeRequested) {
    throw new Error("grok-bot join requires --wake-url and --wake-key-file");
  }

  return {
    sessionId: positionals[0] || "",
    agentType: positionals[1] || "",
    nickname: positionals[2] || "",
    wake: wakeRequested ? {
      adapter: wakeAdapter || "bearer-json",
      url: wakeUrl,
      key: readWakeKeyFile(wakeKeyFile),
    } : null,
  };
}

function parseSendArgs(cmdArgs = []) {
  let injectionMode = "immediate";
  let source = "";
  let index = 0;

  while (index < cmdArgs.length) {
    const arg = cmdArgs[index];
    if (arg === "--queued") {
      injectionMode = "queued";
      index += 1;
      continue;
    }
    if (arg === "--immediate") {
      injectionMode = "immediate";
      index += 1;
      continue;
    }
    if (arg === "--source") {
      source = String(cmdArgs[index + 1] || "").trim();
      index += 2;
      continue;
    }
    break;
  }

  const positionals = cmdArgs.slice(index);

  if (positionals.length < 2) {
    throw new Error("send requires <target> <message>");
  }

  return {
    target: positionals[0],
    message: positionals.slice(1).join(" "),
    injectionMode,
    source,
  };
}

function resolvePollSubscriber(cmdArgs = [], env = process.env) {
  let subscriber = "";
  let autoAck = false;
  let follow = false;
  let intervalSeconds = 2;
  let intervalWasSet = false;

  for (let index = 0; index < cmdArgs.length; index += 1) {
    const arg = String(cmdArgs[index] || "");
    if (arg === "--ack" || arg === "--auto-ack") {
      autoAck = true;
      continue;
    }
    if (arg === "--follow") {
      follow = true;
      continue;
    }
    if (arg === "--interval") {
      const value = cmdArgs[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error("poll --interval requires <seconds>");
      }
      intervalSeconds = Number(value);
      intervalWasSet = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--interval=")) {
      intervalSeconds = Number(arg.slice("--interval=".length));
      intervalWasSet = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown poll option: ${arg}`);
    }
    if (subscriber) {
      throw new Error("poll accepts at most one [subscriber]");
    }
    subscriber = arg.trim();
  }

  subscriber = String(subscriber || env.UFOO_SUBSCRIBER_ID || "").trim();
  if (!subscriber) {
    throw new Error("poll requires [subscriber] or UFOO_SUBSCRIBER_ID");
  }
  if (follow && autoAck) {
    throw new Error("poll --follow cannot be combined with --ack");
  }
  if (intervalWasSet && !follow) {
    throw new Error("poll --interval requires --follow");
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0.25) {
    throw new Error("poll --interval must be at least 0.25 seconds");
  }

  return {
    subscriber,
    autoAck,
    follow,
    intervalSeconds,
  };
}

function resolveAckArgs(cmdArgs = []) {
  let subscriber = "";
  let throughSeq = null;

  for (let index = 0; index < cmdArgs.length; index += 1) {
    const arg = String(cmdArgs[index] || "");
    if (arg === "--through") {
      const value = cmdArgs[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error("ack --through requires <seq>");
      }
      throughSeq = Number(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--through=")) {
      throughSeq = Number(arg.slice("--through=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown ack option: ${arg}`);
    }
    if (subscriber) {
      throw new Error("ack accepts exactly one <subscriber>");
    }
    subscriber = arg.trim();
  }

  if (!subscriber) {
    throw new Error("ack requires <subscriber>");
  }
  if (throughSeq !== null && (!Number.isInteger(throughSeq) || throughSeq <= 0)) {
    throw new Error("ack --through requires a positive integer sequence");
  }

  return { subscriber, throughSeq };
}

async function runBusCoreCommand(eventBus, cmd, cmdArgs = []) {
  switch (cmd) {
    case "deliveries": {
      const { listNativeReceipts, resolveNativeReceipt } = require("../../coordination/bus/nativeReceipts");
      const [subscriber, id, resolution, ...extra] = cmdArgs;
      if (!subscriber || extra.length || (id && !resolution)) throw new Error("Usage: ufoo bus deliveries <subscriber> [<receipt-id> accepted|retry]");
      const result = id ? resolveNativeReceipt(eventBus.projectRoot, subscriber, id, resolution)
        : listNativeReceipts(eventBus.projectRoot, subscriber);
      console.log(JSON.stringify(result, null, 2));
      return {};
    }
    case "init":
      await eventBus.init();
      return {};
    case "join":
      {
        const parsed = parseJoinArgs(cmdArgs);
        const subscriber = parsed.wake
          ? await eventBus.join(parsed.sessionId, parsed.agentType, parsed.nickname, { wake: parsed.wake })
          : await eventBus.join(parsed.sessionId, parsed.agentType, parsed.nickname);
        return { subscriber };
      }
    case "leave":
      await eventBus.leave(cmdArgs[0]);
      return {};
    case "send":
      {
        const publisher = await eventBus.ensureJoined();
        const parsed = parseSendArgs(cmdArgs);
        await eventBus.send(parsed.target, parsed.message, publisher, {
          injectionMode: parsed.injectionMode,
          source: parsed.source,
        });
      }
      return {};
    case "broadcast":
      {
        const publisher = await eventBus.ensureJoined();
        await eventBus.broadcast(cmdArgs[0], publisher);
      }
      return {};
    case "wake":
      {
        const publisher = await eventBus.ensureJoined();
        await eventBus.wake(cmdArgs[0], { publisher, reason: "remote" });
      }
      return {};
    case "check":
      await eventBus.check(cmdArgs[0]);
      return {};
    case "poll":
      {
        const parsed = resolvePollSubscriber(cmdArgs);
        if (parsed.follow) {
          await eventBus.poll(parsed.subscriber, {
            intervalSeconds: parsed.intervalSeconds,
          });
        } else {
          await eventBus.check(parsed.subscriber, parsed.autoAck);
        }
      }
      return {};
    case "ack":
      {
        const parsed = resolveAckArgs(cmdArgs);
        if (parsed.throughSeq !== null) {
          await eventBus.ackThrough(parsed.subscriber, parsed.throughSeq);
        } else {
          await eventBus.ack(parsed.subscriber);
        }
      }
      return {};
    case "consume":
      await eventBus.consume(cmdArgs[0], cmdArgs.includes("--from-beginning"));
      return {};
    case "status":
      await eventBus.status();
      return {};
    case "resolve":
      await eventBus.resolve(cmdArgs[0], cmdArgs[1]);
      return {};
    case "rename":
      await eventBus.rename(cmdArgs[0], cmdArgs[1]);
      return {};
    case "whoami":
      await eventBus.whoami();
      return {};
    default:
      throw new Error(`Unknown bus subcommand: ${cmd}`);
  }
}

module.exports = {
  resolveAckArgs,
  resolvePollSubscriber,
  runBusCoreCommand,
};
