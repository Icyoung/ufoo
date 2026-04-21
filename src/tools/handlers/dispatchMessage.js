const { buildToolError, requireSubscriber, getEventBus } = require("./common");

function normalizeDispatchTarget(rawTarget = "") {
  const target = String(rawTarget || "").trim();
  if (!target) {
    throw buildToolError("invalid_arguments", "dispatch_message requires target");
  }
  if (target === "*") return "broadcast";
  return target;
}

function normalizeDispatchMode(args = {}) {
  const raw = String(
    args.mode || args.injection_mode || args.injectionMode || "immediate"
  )
    .trim()
    .toLowerCase();
  if (raw === "queued") return "queued";
  if (raw === "immediate") return "immediate";
  throw buildToolError(
    "invalid_arguments",
    "dispatch_message mode must be immediate or queued"
  );
}

async function dispatchMessageHandler(ctx = {}, args = {}) {
  const subscriber = requireSubscriber(ctx);
  const target = normalizeDispatchTarget(args.target);
  const message = String(args.message || "").trim();
  const source = String(args.source || subscriber).trim();
  const mode = normalizeDispatchMode(args);

  if (!message) {
    throw buildToolError("invalid_arguments", "dispatch_message requires message");
  }
  if (source !== subscriber) {
    throw buildToolError(
      "forbidden_source",
      "dispatch_message source must match caller subscriber"
    );
  }

  const eventBus = getEventBus(ctx);
  let result;
  try {
    result = target === "broadcast"
      ? await eventBus.broadcast(message, subscriber, {
        injectionMode: mode,
        source: subscriber,
        silent: true,
      })
      : await eventBus.send(target, message, subscriber, {
        injectionMode: mode,
        source: subscriber,
        silent: true,
      });
  } catch (err) {
    if (err && /not found/i.test(String(err.message || ""))) {
      throw buildToolError(
        "invalid_target",
        `dispatch_message target not found: ${target}`
      );
    }
    throw err;
  }

  return {
    ok: true,
    target,
    source: subscriber,
    mode,
    delivered: mode === "immediate" ? result.targets.length : 0,
    queued: mode === "queued" ? result.targets.length : 0,
    targets: result.targets,
    seq: result.seq,
  };
}

module.exports = {
  dispatchMessageHandler,
};
