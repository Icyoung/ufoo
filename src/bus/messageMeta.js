"use strict";

const {
  parseTagsFromOptions,
  validateTags,
  validateTaskId,
  normalizeTagList,
} = require("./envelope");

const INJECTION_MODES = {
  IMMEDIATE: "immediate",
  QUEUED: "queued",
};

function normalizeInjectionMode(value, fallback = INJECTION_MODES.IMMEDIATE) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === INJECTION_MODES.QUEUED) return INJECTION_MODES.QUEUED;
  if (raw === INJECTION_MODES.IMMEDIATE) return INJECTION_MODES.IMMEDIATE;
  return fallback;
}

function normalizeMessageSource(value) {
  const raw = String(value || "").trim();
  return raw || "";
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveTagsFromOptions(options = {}) {
  const dataIn = options && typeof options.data === "object" && options.data ? options.data : {};
  const hasFlagOption = "reply" in options || "report" in options || "fyi" in options;
  const hasTagsOption = "tags" in options;
  const hasTaskOption = "taskId" in options || "task_id" in options || "task" in options;
  const hasReportToOption = "reportTo" in options || "report_to" in options;

  if (hasFlagOption || hasTagsOption || hasTaskOption || hasReportToOption) {
    return parseTagsFromOptions(options);
  }

  const tags = normalizeTagList(dataIn.tags);
  validateTags(tags);
  const taskId = validateTaskId(dataIn.task_id);
  const reportTo = asTrimmedString(dataIn.report_to);
  return { tags, taskId, reportTo };
}

function buildMessageData(message, options = {}) {
  const base = options && typeof options.data === "object" && options.data
    ? { ...options.data }
    : {};
  const data = { ...base, message };
  data.injection_mode = normalizeInjectionMode(
    options.injectionMode || data.injection_mode,
    INJECTION_MODES.IMMEDIATE,
  );
  const source = normalizeMessageSource(options.source || data.source);
  if (source) {
    data.source = source;
  } else {
    delete data.source;
  }

  const { tags, taskId, reportTo } = resolveTagsFromOptions(options);

  if (tags.length > 0) {
    data.tags = tags;
  } else {
    delete data.tags;
  }

  if (taskId) {
    data.task_id = taskId;
  } else {
    delete data.task_id;
  }

  if (reportTo) {
    data.report_to = reportTo;
  } else {
    delete data.report_to;
  }

  return data;
}

function getInjectionModeFromEvent(evt, fallback = INJECTION_MODES.IMMEDIATE) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  return normalizeInjectionMode(
    data.injection_mode || evt?.injection_mode,
    fallback,
  );
}

function getTagsFromEvent(evt) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  const tags = normalizeTagList(data.tags);
  try {
    validateTags(tags);
  } catch {
    return [];
  }
  return tags;
}

function getTaskIdFromEvent(evt) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  try {
    return validateTaskId(data.task_id);
  } catch {
    return "";
  }
}

function getReportToFromEvent(evt) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  return asTrimmedString(data.report_to);
}

module.exports = {
  INJECTION_MODES,
  normalizeInjectionMode,
  normalizeMessageSource,
  buildMessageData,
  getInjectionModeFromEvent,
  getTagsFromEvent,
  getTaskIdFromEvent,
  getReportToFromEvent,
};
