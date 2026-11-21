"use strict";

const { randomUUID } = require("crypto");

async function runAuxiliaryModelRequest(transport, { purpose, onEvent, ...request }) {
  const startedAt = Date.now();
  const metadata = {
    modelRequestId: randomUUID(), purpose, provider: request.provider, model: request.model,
    transport: transport.name || transport.id || "", channel: request.requestProfile || transport.name || transport.id || "",
  };
  const observe = async (type, properties = {}) => {
    try { await onEvent?.({ ...metadata, ...properties, type }); } catch { /* observer only */ }
  };
  await observe("model.started");
  let cacheRequest;
  try {
    const result = await transport.runTurn({ ...request, requestPurpose: purpose, onRequest: value => { cacheRequest = value; } });
    await observe("model.completed", { durationMs: Date.now() - startedAt, usage: result?.usage, cacheRequest,
      channel: cacheRequest?.channel || metadata.channel, model: result?.actualModel || request.model, providerRequestId: result?.responseId });
    return result;
  } catch (error) {
    await observe("model.failed", { durationMs: Date.now() - startedAt, cacheRequest,
      channel: cacheRequest?.channel || metadata.channel, code: error.code || "provider_error" });
    throw error;
  }
}

module.exports = { runAuxiliaryModelRequest };
