"use strict";

const ACTION_TAGS = ["reply", "report", "fyi"];
const ACTION_TAG_SET = new Set(ACTION_TAGS);
const MUTUALLY_EXCLUSIVE_WITH_FYI = new Set(["reply", "report"]);

const TAG_RENDER_ORDER = ["reply", "report", "fyi"];
const MAX_TAG_COUNT = 8;

const TASK_ID_PATTERN = /^[A-Za-z0-9_.\-]+$/;
const TASK_ID_MAX_LENGTH = 64;

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTagList(input) {
  if (input == null) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const tag = asTrimmedString(item).toLowerCase();
    if (!tag) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function validateTags(tags) {
  if (tags.length > MAX_TAG_COUNT) {
    throw new Error(`Too many tags (max ${MAX_TAG_COUNT}): ${tags.join(", ")}`);
  }
  for (const tag of tags) {
    if (!ACTION_TAG_SET.has(tag)) {
      throw new Error(`Unknown tag "${tag}". Allowed action tags: ${ACTION_TAGS.join(", ")}`);
    }
  }
  if (tags.includes("fyi")) {
    const conflicts = tags.filter((tag) => MUTUALLY_EXCLUSIVE_WITH_FYI.has(tag));
    if (conflicts.length > 0) {
      throw new Error(`[fyi] is mutually exclusive with [${conflicts.join("], [")}]`);
    }
  }
}

function validateTaskId(taskId) {
  const id = asTrimmedString(taskId);
  if (!id) return "";
  if (id.length > TASK_ID_MAX_LENGTH) {
    throw new Error(`task_id too long (max ${TASK_ID_MAX_LENGTH}): "${id}"`);
  }
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`task_id contains invalid characters (allowed: A-Z a-z 0-9 _ . -): "${id}"`);
  }
  return id;
}

function sortTagsForRender(tags) {
  const order = new Map(TAG_RENDER_ORDER.map((tag, index) => [tag, index]));
  return tags.slice().sort((a, b) => {
    const ai = order.has(a) ? order.get(a) : TAG_RENDER_ORDER.length;
    const bi = order.has(b) ? order.get(b) : TAG_RENDER_ORDER.length;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function parseTagsFromOptions(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const collected = [];
  if (opts.reply) collected.push("reply");
  if (opts.report) collected.push("report");
  if (opts.fyi) collected.push("fyi");

  if (Array.isArray(opts.tags)) {
    for (const tag of opts.tags) {
      const value = asTrimmedString(tag).toLowerCase();
      if (value) collected.push(value);
    }
  } else if (typeof opts.tags === "string") {
    for (const tag of opts.tags.split(/[\s,]+/)) {
      const value = asTrimmedString(tag).toLowerCase();
      if (value) collected.push(value);
    }
  }

  const tags = normalizeTagList(collected);
  validateTags(tags);

  const taskId = validateTaskId(opts.taskId || opts.task_id || opts.task);
  const reportTo = asTrimmedString(opts.reportTo || opts.report_to);

  return { tags, taskId, reportTo };
}

function formatTagList({ tags = [], taskId = "" } = {}) {
  const segments = [];
  for (const tag of sortTagsForRender(tags)) {
    segments.push(`[${tag}]`);
  }
  const id = asTrimmedString(taskId);
  if (id) segments.push(`[task:${id}]`);
  return segments.join(" ");
}

function buildPartyLabel({ id = "", nickname = "" } = {}) {
  const trimmedId = asTrimmedString(id);
  const trimmedNickname = asTrimmedString(nickname);
  if (!trimmedId && !trimmedNickname) return "";
  if (trimmedId && trimmedNickname && trimmedId !== trimmedNickname) {
    return `${trimmedId}(${trimmedNickname})`;
  }
  return trimmedId || trimmedNickname;
}

function renderHeader({
  kind = "bus",
  fromId = "",
  fromNickname = "",
  toId = "",
  toNickname = "",
  tags = [],
  taskId = "",
} = {}) {
  let prefix;
  let partyLabel;
  if (kind === "manual") {
    prefix = "[manual]<to:";
    partyLabel = buildPartyLabel({ id: toId, nickname: toNickname });
  } else {
    prefix = "[ufoo]<from:";
    partyLabel = buildPartyLabel({ id: fromId, nickname: fromNickname });
  }
  if (!partyLabel) partyLabel = "unknown";

  const tagSegment = formatTagList({ tags, taskId });
  const head = `${prefix}${partyLabel}>`;
  return tagSegment ? `${head} ${tagSegment}` : head;
}

function renderEnvelope({
  kind = "bus",
  fromId = "",
  fromNickname = "",
  toId = "",
  toNickname = "",
  tags = [],
  taskId = "",
  message = "",
} = {}) {
  const header = renderHeader({ kind, fromId, fromNickname, toId, toNickname, tags, taskId });
  const body = String(message || "");
  return body ? `${header}\n${body}` : header;
}

module.exports = {
  ACTION_TAGS,
  TAG_RENDER_ORDER,
  MAX_TAG_COUNT,
  TASK_ID_PATTERN,
  TASK_ID_MAX_LENGTH,
  normalizeTagList,
  validateTags,
  validateTaskId,
  sortTagsForRender,
  parseTagsFromOptions,
  formatTagList,
  renderHeader,
  renderEnvelope,
};
