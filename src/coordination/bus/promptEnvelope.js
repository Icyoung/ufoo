"use strict";

const { getTagsFromEvent, getTaskIdFromEvent } = require("./messageMeta");
const { renderEnvelope } = require("./envelope");

const MANUAL_INJECTION_SOURCES = new Set([
  "chat-direct",
  "chat-internal-agent-view",
  "chat-manual",
  "manual",
]);

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shouldRenderPromptEnvelope(evt = {}) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  return data.raw_inject !== true
    && data.rawInject !== true
    && data.envelope !== false
    && data.prompt_envelope !== false;
}

function getPublisherId(evt = {}) {
  const publisher = evt.publisher;
  if (typeof publisher === "string") return publisher;
  if (publisher && typeof publisher === "object") {
    return asTrimmedString(publisher.subscriber || publisher.id || publisher.nickname);
  }
  return "";
}

function getAgentNickname(meta = {}) {
  return asTrimmedString(meta.display_nickname || meta.nickname || meta.scoped_nickname);
}

function buildPromptInjectionText(evt = {}, subscriber = "", agents = {}) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  const message = String(data.message || "");
  if (!shouldRenderPromptEnvelope(evt)) return message;

  const source = asTrimmedString(data.source).toLowerCase();
  const kind = MANUAL_INJECTION_SOURCES.has(source) ? "manual" : "bus";
  const publisherId = getPublisherId(evt);
  const publisherMeta = publisherId && agents ? agents[publisherId] : null;
  const targetMeta = subscriber && agents ? agents[subscriber] : null;

  return renderEnvelope({
    kind,
    fromId: publisherId,
    fromNickname: publisherMeta ? getAgentNickname(publisherMeta) : "",
    toId: subscriber,
    toNickname: targetMeta ? getAgentNickname(targetMeta) : "",
    tags: getTagsFromEvent(evt),
    taskId: getTaskIdFromEvent(evt),
    message,
  });
}

module.exports = {
  buildPromptInjectionText,
  getPublisherId,
  shouldRenderPromptEnvelope,
};
