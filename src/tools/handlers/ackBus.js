const { buildToolError, requireSubscriber, getEventBus } = require("./common");

async function ackBusHandler(ctx = {}, args = {}) {
  const subscriber = requireSubscriber(ctx);
  const requestedSubscriber = String(args.subscriber || subscriber).trim();
  const rawThroughSeq = args.through_seq ?? args.throughSeq;
  const hasThroughSeq = rawThroughSeq !== undefined && rawThroughSeq !== null;
  const throughSeq = hasThroughSeq ? Number(rawThroughSeq) : null;

  if (requestedSubscriber !== subscriber) {
    throw buildToolError(
      "forbidden_ack",
      "ack_bus can only acknowledge the caller subscriber queue"
    );
  }
  if (hasThroughSeq && (!Number.isInteger(throughSeq) || throughSeq <= 0)) {
    throw buildToolError(
      "invalid_arguments",
      "ack_bus through_seq must be a positive integer"
    );
  }

  const eventBus = getEventBus(ctx);
  const count = hasThroughSeq
    ? await eventBus.ackThrough(subscriber, throughSeq)
    : await eventBus.ack(subscriber);

  return {
    ok: true,
    subscriber,
    acknowledged: count,
    ...(hasThroughSeq ? { through_seq: throughSeq } : {}),
  };
}

module.exports = {
  ackBusHandler,
};
