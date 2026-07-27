"use strict";

/**
 * Shared tool-merge → ufoo-ui tool.* event helpers for Rust hosts.
 */

const fmt = require("./format");

const EXIT_SUSPEND = 75;

function createToolMergePublisher(publish) {
  let merge = null;
  let mergeId = 1;
  let scope = 0;

  function beginScope() {
    flush();
    scope += 1;
  }

  function flush() {
    if (!merge || !Array.isArray(merge.entries) || merge.entries.length === 0) {
      merge = null;
      return;
    }
    const summary = fmt.buildMergedToolSummaryText(merge.entries);
    const detail = fmt.buildMergedToolExpandedLines(merge.entries).join("\n");
    const row = typeof fmt.buildToolMergeRowText === "function"
      ? fmt.buildToolMergeRowText(merge.entries)
      : (merge.entries.length >= 2
        ? `· ${summary} (Ctrl+O expand)`
        : summary);
    publish("tool.group", {
      id: `tool-merge-${merge.id}`,
      summary: row || summary,
      detail,
      expanded_text: detail,
      count: merge.entries.length,
    });
    merge = null;
  }

  function pushTool(entry = {}) {
    merge = fmt.appendToolMergeEntry(merge, entry, scope, mergeId);
    if (merge && merge.id) mergeId = Math.max(mergeId, Number(merge.id) + 1);
    // Live collapsed summary while group grows.
    if (merge) {
      publish("tool.start", {
        id: `tool-merge-${merge.id}`,
        summary: fmt.buildMergedToolSummaryText(merge.entries),
      });
    }
  }

  return {
    beginScope,
    flush,
    pushTool,
    EXIT_SUSPEND,
  };
}

module.exports = {
  EXIT_SUSPEND,
  createToolMergePublisher,
};
