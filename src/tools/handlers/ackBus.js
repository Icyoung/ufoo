const { buildToolError, requireSubscriber, getEventBus } = require("./common");

async function ackBusHandler(ctx = {}, args = {}) {
  const subscriber = requireSubscriber(ctx);
  const requestedSubscriber = String(args.subscriber || subscriber).trim();

  if (requestedSubscriber !== subscriber) {
    throw buildToolError(
      "forbidden_ack",
      "ack_bus can only acknowledge the caller subscriber queue"
    );
  }

  const eventBus = getEventBus(ctx);
  const count = await eventBus.ack(subscriber);

  return {
    ok: true,
    subscriber,
    acknowledged: count,
  };
}

module.exports = {
  ackBusHandler,
};
