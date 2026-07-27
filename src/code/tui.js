const fmt = require("../ui/format");

const {
  STATUS_INDICATORS,
  StreamBuffer,
  UCODE_BANNER_LINES,
  UCODE_VERSION,
  appendToolMergeEntry,
  buildMergedToolExpandedLines,
  buildMergedToolSummaryText,
  buildUcodeBannerLines,
  clampCursorPos,
  createEscapeTagStripper,
  cycleAgentSelectionIndex,
  deleteWordBeforeCursor,
  displayCellWidth,
  filterSelectableAgents,
  findLogicalLineEnd,
  findLogicalLineStart,
  formatPendingElapsed,
  loadActiveAgents,
  moveCursorByWord,
  moveCursorHorizontally,
  moveCursorToVisualLineBoundary,
  moveCursorVertically,
  normalizeBashToolCommand,
  normalizeToolMergeEntry,
  parseActiveAgentsFromBusStatus,
  renderLogLinesWithMarkdown,
  renderLogLinesWithMarkdownAnsi,
  resolveAgentSelectionOnDown,
  resolveHistoryDownTransition,
  shouldClearAgentSelectionOnUp,
  shouldEnterAgentSelection,
  shouldUseUcodeTui,
  splitStreamingLogChunk,
  stripLeakedEscapeTags,
} = fmt;

function runUcodeTui(props = {}) {
  const { resolveTuiLaunchPlan } = require("../ui/tuiLauncher");
  const plan = resolveTuiLaunchPlan({
    mode: props.tuiMode || process.env.UFOO_TUI,
    surface: "ucode",
  });
  if (plan.mode !== "rust") {
    const err = new Error(`Rust TUI unavailable (${plan.reason})`);
    err.code = "UFOO_TUI_UNAVAILABLE";
    err.plan = plan;
    throw err;
  }
  const { runUcodeRust } = require("../ui/rustUcodeHost");
  return runUcodeRust({ ...props, tuiMode: "rust" });
}

module.exports = {
  STATUS_INDICATORS,
  UCODE_BANNER_LINES,
  UCODE_VERSION,
  StreamBuffer,
  displayCellWidth,
  buildUcodeBannerLines,
  parseActiveAgentsFromBusStatus,
  shouldUseUcodeTui,
  renderLogLinesWithMarkdown,
  renderLogLinesWithMarkdownAnsi,
  shouldEnterAgentSelection,
  resolveAgentSelectionOnDown,
  cycleAgentSelectionIndex,
  shouldClearAgentSelectionOnUp,
  moveCursorHorizontally,
  clampCursorPos,
  findLogicalLineStart,
  findLogicalLineEnd,
  moveCursorToVisualLineBoundary,
  moveCursorVertically,
  deleteWordBeforeCursor,
  moveCursorByWord,
  resolveHistoryDownTransition,
  filterSelectableAgents,
  stripLeakedEscapeTags,
  splitStreamingLogChunk,
  createEscapeTagStripper,
  formatPendingElapsed,
  appendToolMergeEntry,
  normalizeBashToolCommand,
  normalizeToolMergeEntry,
  buildMergedToolSummaryText,
  buildMergedToolExpandedLines,
  loadActiveAgents,
  runUcodeTui,
};
