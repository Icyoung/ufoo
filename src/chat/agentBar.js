const { stripAnsi, truncateAnsi } = require("./text");

function computeAgentBar(options = {}) {
  const {
    cols = 80,
    hintText = "",
    focusMode = "input",
    selectedAgentIndex = -1,
    activeAgents = [],
    viewingAgent = null,
    agentListWindowStart = 0,
    maxAgentWindow = 4,
    getAgentLabel = (id) => id,
  } = options;

  const hintAnsi = `\x1b[90m│ ${hintText}\x1b[0m`;
  const selectionIndex = focusMode === "dashboard"
    ? (selectedAgentIndex > 0 ? selectedAgentIndex - 1 : -1)
    : activeAgents.indexOf(viewingAgent);
  const maxAgentLen = Math.max(0, cols - 1 - 2 - stripAnsi(hintAnsi).length);
  let windowItems = Math.max(1, Math.min(maxAgentWindow, activeAgents.length));
  let start = agentListWindowStart;
  const ufooItem = focusMode === "dashboard" && selectedAgentIndex === 0
    ? "\x1b[90;7mucode\x1b[0m"
    : "\x1b[36mucode\x1b[0m";
  const ufooLen = stripAnsi(ufooItem).length;

  const computeStart = (items) => {
    if (activeAgents.length === 0) return 0;
    let s = start;
    if (selectionIndex >= 0) {
      if (selectionIndex < s) {
        s = selectionIndex;
      } else if (selectionIndex >= s + items) {
        s = selectionIndex - items + 1;
      }
    }
    const maxStart = Math.max(0, activeAgents.length - items);
    if (s > maxStart) s = maxStart;
    if (s < 0) s = 0;
    return s;
  };

  const truncateLabel = (label, maxLen) => {
    const text = String(label || "");
    if (maxLen <= 0) return "";
    if (text.length <= maxLen) return text;
    if (maxLen <= 3) return text.slice(0, maxLen);
    return `${text.slice(0, maxLen - 3)}...`;
  };

  const buildAgentSegment = (items, maxLabelLen) => {
    const s = computeStart(items);
    const e = s + items;
    const visible = activeAgents.slice(s, e);
    const leftMore = s > 0 ? "\x1b[90m<\x1b[0m " : "";
    const rightMore = e < activeAgents.length ? " \x1b[90m>\x1b[0m" : "";
    let agentParts = [];
    if (activeAgents.length > 0) {
      agentParts = visible.map((agent, i) => {
        const rawLabel = getAgentLabel(agent);
        const label = maxLabelLen ? truncateLabel(rawLabel, maxLabelLen) : rawLabel;
        const idx = s + i + 1; // +1 for ucode at index 0
        if (focusMode === "dashboard" && idx === selectedAgentIndex) {
          return `\x1b[90;7m${label}\x1b[0m`;
        }
        if (agent === viewingAgent) return `\x1b[1;36m${label}\x1b[0m`;
        return `\x1b[36m${label}\x1b[0m`;
      });
    }
    const agentsText = activeAgents.length > 0
      ? `${leftMore}${agentParts.join("  ")}${rightMore}`
      : "\x1b[36mnone\x1b[0m";
    return { segment: `${ufooItem}  ${agentsText}`, start: s };
  };

  let segmentInfo = buildAgentSegment(windowItems, 0);
  while (windowItems > 0) {
    const s = computeStart(windowItems);
    const e = s + windowItems;
    const hasLeft = s > 0;
    const hasRight = e < activeAgents.length;
    const spacingLen = windowItems > 1 ? (windowItems - 1) * 2 : 0;
    const overhead = ufooLen + 2 + (hasLeft ? 2 : 0) + (hasRight ? 2 : 0) + spacingLen;
    const available = maxAgentLen - overhead;
    let maxLabelLen = windowItems > 0 ? Math.floor(available / windowItems) : 0;
    if (windowItems > 1 && maxLabelLen < 3) {
      windowItems -= 1;
      segmentInfo = buildAgentSegment(windowItems, 0);
      continue;
    }
    if (maxLabelLen < 1) maxLabelLen = 1;
    segmentInfo = buildAgentSegment(windowItems, maxLabelLen);
    if (stripAnsi(segmentInfo.segment).length <= maxAgentLen || windowItems === 1) break;
    windowItems -= 1;
    segmentInfo = buildAgentSegment(windowItems, 0);
  }
  start = segmentInfo.start;
  const agentSegment = segmentInfo.segment;

  let bar = ` ${agentSegment}  ${hintAnsi}`;
  let barLen = stripAnsi(bar).length;
  if (barLen > cols) {
    bar = truncateAnsi(bar, cols);
    barLen = stripAnsi(bar).length;
  }
  const pad = Math.max(0, cols - barLen);

  return {
    bar: `${bar}${" ".repeat(pad)}`,
    windowStart: start,
  };
}

module.exports = {
  computeAgentBar,
};
