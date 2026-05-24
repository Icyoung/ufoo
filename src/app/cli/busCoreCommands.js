"use strict";

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

async function runBusCoreCommand(eventBus, cmd, cmdArgs = []) {
  switch (cmd) {
    case "init":
      await eventBus.init();
      return {};
    case "join":
      return {
        subscriber: await eventBus.join(cmdArgs[0], cmdArgs[1], cmdArgs[2]),
      };
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
    case "ack":
      await eventBus.ack(cmdArgs[0]);
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

module.exports = { runBusCoreCommand };
