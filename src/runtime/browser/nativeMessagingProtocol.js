"use strict";

const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

/**
 * Encode a JSON-serializable object into Chrome Native Messaging 4-byte LE framed buffer.
 */
function encodeNativeMessage(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native messaging payload exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Create a streaming decoder for Chrome Native Messaging stdin chunks.
 */
function createNativeMessageReader(onMessage, onError = () => {}) {
  let buffer = Buffer.alloc(0);

  return function push(chunk) {
    if (!chunk || !chunk.length) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Invalid native message length: ${length}`));
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.slice(4, 4 + length).toString("utf8");
      buffer = buffer.slice(4 + length);
      try {
        onMessage(JSON.parse(body));
      } catch (error) {
        onError(error);
      }
    }
  };
}

module.exports = {
  MAX_NATIVE_MESSAGE_BYTES,
  encodeNativeMessage,
  createNativeMessageReader,
};
