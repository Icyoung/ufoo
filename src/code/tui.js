const fmt = require("../ui/format");

const {
  STATUS_INDICATORS,
  StreamBuffer,
  UCODE_BANNER_LINES,
  UCODE_VERSION,
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
  formatHighlightedUserInput,
  formatPendingElapsed,
  loadActiveAgents,
  moveCursorByWord,
  moveCursorHorizontally,
  moveCursorToVisualLineBoundary,
  moveCursorVertically,
  normalizeBashToolCommand,
  normalizeModelLabel,
  normalizeToolMergeEntry,
  parseActiveAgentsFromBusStatus,
  renderLogLinesWithMarkdown,
  resolveAgentSelectionOnDown,
  resolveHistoryDownTransition,
  shouldClearAgentSelectionOnUp,
  shouldEnterAgentSelection,
  shouldUseUcodeTui,
  stripLeakedEscapeTags,
} = fmt;

function safeRead(getter, fallback = undefined) {
  try {
    return getter();
  } catch {
    return fallback;
  }
}

function resolveLogContentWidth({ logBox = null, screen = null, fallback = 80 } = {}) {
  const coords = safeRead(() => logBox && typeof logBox._getCoords === "function" ? logBox._getCoords() : null, null);
  if (coords && Number.isFinite(coords.xl) && Number.isFinite(coords.xi)) {
    return Math.max(1, coords.xl - coords.xi);
  }
  const width = safeRead(() => logBox && logBox.width, null);
  if (typeof width === "number") return Math.max(1, width);
  const screenWidth = safeRead(() => screen && screen.width, null);
  if (typeof screenWidth === "number") return Math.max(1, screenWidth);
  const screenCols = safeRead(() => screen && screen.cols, null);
  if (typeof screenCols === "number") return Math.max(1, screenCols);
  return Math.max(1, fallback);
}

function escapeBlessedLiteral(text) {
  const raw = String(text == null ? "" : text);
  const safe = raw.replace(/\{\/escape\}/g, "{open}/escape{close}");
  return `{escape}${safe}{/escape}`;
}

function buildUcodeBannerBlessedLines({
  model = "",
  engine = "ufoo-core",
  nickname = "",
  agentId = "",
  workspaceRoot = "",
  sessionId = "",
  width = 0,
} = {}) {
  const modelLabel = normalizeModelLabel(model);
  void width;
  void engine;
  void nickname;
  void agentId;

  const path = require("path");
  const os = require("os");
  const currentDir = workspaceRoot || process.cwd();
  const homeDir = os.homedir();

  let shortPath = currentDir;
  if (currentDir.startsWith(homeDir)) {
    shortPath = currentDir.replace(homeDir, "~");
  }
  shortPath = path.normalize(shortPath);

  const logoLines = UCODE_BANNER_LINES.map(
    (line) => `{cyan-fg}${escapeBlessedLiteral(line)}{/cyan-fg}`
  );
  const infoLines = [
    `{gray-fg}Version:{/gray-fg} {cyan-fg}{bold}${escapeBlessedLiteral(UCODE_VERSION)}{/bold}{/cyan-fg}`,
    `{gray-fg}Model:{/gray-fg} {yellow-fg}${escapeBlessedLiteral(modelLabel)}{/yellow-fg}`,
    `{gray-fg}Dictionary:{/gray-fg} {gray-fg}${escapeBlessedLiteral(shortPath)}{/gray-fg}`,
  ];
  const normalizedSessionId = String(sessionId || "").trim();
  if (normalizedSessionId) {
    infoLines.push(`{gray-fg}Session:{/gray-fg} {gray-fg}${escapeBlessedLiteral(normalizedSessionId)}{/gray-fg}`);
  }
  const logoPadding = " ".repeat(
    UCODE_BANNER_LINES.reduce((max, line) => Math.max(max, String(line || "").length), 0)
  );
  const rows = Math.max(logoLines.length, infoLines.length);

  return Array.from({ length: rows }, (_, index) => {
    const logoLine = logoLines[index] || logoPadding;
    const info = infoLines[index] || "";
    return `  ${logoLine}  ${info}`;
  });
}

function runUcodeTui(props = {}) {
  if (String(process.env.UFOO_TUI || "").trim().toLowerCase() === "ink") {
    const { runUcodeInkTui } = require("../ui/components/UcodeApp");
    return runUcodeInkTui(props);
  }
  return runUcodeBlessedTui(props);
}

function runUcodeBlessedTui({
  stdin = process.stdin,
  stdout = process.stdout,
  runSingleCommand = () => ({ kind: "empty" }),
  runNaturalLanguageTask = async () => ({ ok: true, summary: "ok" }),
  runUbusCommand = async () => ({ ok: false, error: "ubus unsupported", summary: "" }),
  formatNlResult = () => "ok",
  workspaceRoot = process.cwd(),
  state = {},
  resumeSessionState = () => ({ ok: false, error: "resume unsupported", sessionId: "", restoredMessages: 0 }),
  persistSessionState = () => ({ ok: true }),
  autoBus = {},
} = {}) {
  return new Promise((resolve) => {
    const blessed = require("blessed");
    const { execFileSync } = require("child_process");
    const { createChatLayout } = require("../chat/layout");
    const { computeDashboardContent } = require("../chat/dashboardView");
    const { escapeBlessed, stripBlessedTags } = require("../chat/text");
    const currentSubscriberId = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
    const autoBusEnabled = Boolean(autoBus && autoBus.enabled);
    const autoBusSubscriberId = String((autoBus && autoBus.subscriberId) || currentSubscriberId || "").trim();
    const getAutoBusPendingCount = typeof (autoBus && autoBus.getPendingCount) === "function"
      ? autoBus.getPendingCount
      : () => 0;

    let closing = false;
    let chain = Promise.resolve();
    let statusInterval = null;
    let statusIndex = 0;
    let activeAgents = [];
    let activeAgentMetaMap = new Map();
    let targetAgent = null;
    let selectedAgentIndex = -1;
    let agentListWindowStart = 0;
    let agentSelectionMode = false;
    let pendingTask = null;
    const backgroundTasks = new Map();
    let backgroundSeq = 0;
    const logRenderState = { inCodeBlock: false };
    const inputHistory = [];
    let historyIndex = -1;
    let activeToolMerge = null;
    let lastMergedToolGroup = null;
    let toolMergeId = 0;
    let cursorPos = 0;
    let preferredCol = null;
    let currentInputHeight = 4;
    const MIN_INPUT_CONTENT_HEIGHT = 1;
    const MAX_INPUT_CONTENT_HEIGHT = 8;
    const DASHBOARD_HEIGHT = 1;
    let autoBusTimer = null;
    let autoBusQueued = false;
    let autoBusError = "";
    const inputMath = require("../chat/inputMath");

    const {
      screen,
      logBox,
      statusLine,
      completionPanel,
      dashboard,
      inputTopLine,
      promptBox,
      input,
    } = createChatLayout({
      blessed,
      currentInputHeight: 4,
      version: UCODE_VERSION,
      logBorder: false,
      logScrollbar: false,
    });

    if (completionPanel && typeof completionPanel.hide === "function") {
      completionPanel.hide();
    }

    const getAgentTag = (agent) => {
      if (!agent) return "";
      if (agent.id) return `${agent.type}:${agent.id.slice(0, 6)}`;
      return agent.type;
    };

    const getAgentLabel = (id) => {
      const meta = activeAgentMetaMap.get(id);
      if (!meta) return id;
      if (meta.nickname) return meta.nickname;
      return getAgentTag(meta);
    };

    const refreshAgents = () => {
      const list = filterSelectableAgents(
        loadActiveAgents(workspaceRoot),
        currentSubscriberId
      );
      activeAgents = list.map((agent) => agent.fullId);
      activeAgentMetaMap = new Map(list.map((agent) => [agent.fullId, agent]));
      if (targetAgent && !activeAgentMetaMap.has(targetAgent)) {
        targetAgent = null;
      }
      selectedAgentIndex = targetAgent ? activeAgents.indexOf(targetAgent) : -1;
    };

    const setPrompt = () => {
      const content = targetAgent ? `>@${getAgentLabel(targetAgent)}` : ">";
      promptBox.setContent(content);
      const plain = stripBlessedTags(content);
      promptBox.width = Math.max(2, plain.length + 1);
      input.left = promptBox.width;
      input.width = `100%-${promptBox.width}`;
      resizeInput();
    };

    // --- Cursor position helpers (mirrors chat inputListenerController) ---
    const getInnerWidth = () => {
      const promptWidth = typeof promptBox.width === "number" ? promptBox.width : 2;
      return inputMath.getInnerWidth({ input, screen, promptWidth });
    };

    const getWrapWidth = () => inputMath.getWrapWidth(input, getInnerWidth());

    const resetPreferredCol = () => {
      preferredCol = null;
    };

    const ensureInputCursorVisible = () => {
      const innerWidth = getWrapWidth();
      if (innerWidth <= 0) return;
      const totalRows = inputMath.countLines(input.value || "", innerWidth, (v) => input.strWidth(v));
      const visibleRows = Math.max(1, input.height || 1);
      const { row } = inputMath.getCursorRowCol(input.value || "", cursorPos, innerWidth, (v) => input.strWidth(v));
      let base = input.childBase || 0;
      const maxBase = Math.max(0, totalRows - visibleRows);
      if (row < base) base = row;
      else if (row >= base + visibleRows) base = row - visibleRows + 1;
      if (base > maxBase) base = maxBase;
      if (base < 0) base = 0;
      if (base !== input.childBase) {
        input.childBase = base;
        if (typeof input.scrollTo === "function") input.scrollTo(base);
      }
    };

    const resizeInput = () => {
      const innerWidth = getWrapWidth();
      if (innerWidth <= 0) return;
      const totalRows = inputMath.countLines(input.value || "", innerWidth, (v) => input.strWidth(v));
      const contentHeight = Math.min(
        MAX_INPUT_CONTENT_HEIGHT,
        Math.max(MIN_INPUT_CONTENT_HEIGHT, totalRows)
      );
      const targetHeight = contentHeight + DASHBOARD_HEIGHT + 2;
      if (targetHeight !== currentInputHeight) {
        currentInputHeight = targetHeight;
        input.height = contentHeight;
        promptBox.height = contentHeight;
        if (inputTopLine) inputTopLine.bottom = currentInputHeight - 1;
      }
      statusLine.bottom = currentInputHeight;
      logBox.height = Math.max(1, screen.height - currentInputHeight - 1);
      ensureInputCursorVisible();
    };

    const renderInput = () => {
      resizeInput();
      ensureInputCursorVisible();
      input._updateCursor();
      screen.render();
    };

    const setCursor = (nextPos) => {
      cursorPos = clampCursorPos(nextPos, input.value || "");
      ensureInputCursorVisible();
      input._updateCursor();
      screen.render();
    };

    const setInputValue = (value) => {
      input.setValue(value || "");
      cursorPos = (value || "").length;
      resetPreferredCol();
      renderInput();
    };

    const replaceInputRange = (start, end, replacement = "") => {
      const value = input.value || "";
      const safeStart = clampCursorPos(start, value);
      const safeEnd = clampCursorPos(end, value);
      const from = Math.min(safeStart, safeEnd);
      const to = Math.max(safeStart, safeEnd);
      input.value = value.slice(0, from) + String(replacement || "") + value.slice(to);
      cursorPos = from + String(replacement || "").length;
      resetPreferredCol();
      renderInput();
    };

    const insertTextAtCursor = (text = "") => {
      const normalized = inputMath.normalizePaste(text);
      if (!normalized) return;
      replaceInputRange(cursorPos, cursorPos, normalized);
    };

    const deleteBeforeCursor = () => {
      if (cursorPos <= 0) return;
      replaceInputRange(cursorPos - 1, cursorPos, "");
    };

    const deleteAtCursor = () => {
      const value = input.value || "";
      if (cursorPos >= value.length) return;
      replaceInputRange(cursorPos, cursorPos + 1, "");
    };

    const deleteToBoundary = (boundary) => {
      const value = input.value || "";
      const innerWidth = getWrapWidth();
      const target = boundary === "end"
        ? moveCursorToVisualLineBoundary({
          cursorPos,
          inputValue: value,
          width: innerWidth,
          boundary: "end",
          strWidth: (v) => input.strWidth(v),
        })
        : moveCursorToVisualLineBoundary({
          cursorPos,
          inputValue: value,
          width: innerWidth,
          boundary: "start",
          strWidth: (v) => input.strWidth(v),
        });
      if (target === cursorPos && boundary === "end" && value[cursorPos] === "\n") {
        replaceInputRange(cursorPos, cursorPos + 1, "");
        return;
      }
      if (target === cursorPos && boundary === "start" && value[cursorPos - 1] === "\n") {
        replaceInputRange(cursorPos - 1, cursorPos, "");
        return;
      }
      replaceInputRange(Math.min(cursorPos, target), Math.max(cursorPos, target), "");
    };

    // Override _updateCursor to use our tracked cursorPos
    input._updateCursor = function () {
      if (this.screen.focused !== this) return;
      let lpos;
      try { lpos = this._getCoords(); } catch { return; }
      if (!lpos) return;
      const innerWidth = getWrapWidth();
      if (innerWidth <= 0) return;
      ensureInputCursorVisible();
      const { row, col } = inputMath.getCursorRowCol(this.value || "", cursorPos, innerWidth, (v) => this.strWidth(v));
      const scrollOffset = this.childBase || 0;
      const displayRow = row - scrollOffset;
      const safeCol = Math.min(Math.max(0, col), innerWidth - 1);
      const cy = lpos.yi + displayRow;
      const cx = lpos.xi + safeCol;
      this.screen.program.cup(cy, cx);
      this.screen.program.showCursor();
    };

    // Override _listener to support cursor-aware editing
    let lastKeyRef = null;
    let skipSubmitKeyRef = null;
    input._listener = function (ch, key) {
      const keyName = key && key.name;

      // Dedup: blessed delivers the same key object via element 'keypress' event
      // from both readInput's __listener binding and screen's focused.emit('keypress').
      // Use object identity to skip the duplicate delivery.
      if (key && key === lastKeyRef) return;
      lastKeyRef = key || null;

      if (keyName === "escape") return;

      if (keyName === "return" || keyName === "enter") {
        const value = this.value || "";
        if (key && (key.shift || key.meta)) {
          insertTextAtCursor("\n");
          skipSubmitKeyRef = key || true;
          return;
        }
        if (cursorPos > 0 && value[cursorPos - 1] === "\\") {
          replaceInputRange(cursorPos - 1, cursorPos, "\n");
          skipSubmitKeyRef = key || true;
          return;
        }
        return;
      }

      // Arrow keys handled by input.key() handlers below
      if (keyName === "left" || keyName === "right" || keyName === "up" || keyName === "down") return;

      if (key && key.ctrl) {
        if (keyName === "a") {
          setCursor(moveCursorToVisualLineBoundary({
            cursorPos,
            inputValue: this.value || "",
            width: getWrapWidth(),
            boundary: "start",
            strWidth: (v) => this.strWidth(v),
          }));
          resetPreferredCol();
          return;
        }
        if (keyName === "e") {
          setCursor(moveCursorToVisualLineBoundary({
            cursorPos,
            inputValue: this.value || "",
            width: getWrapWidth(),
            boundary: "end",
            strWidth: (v) => this.strWidth(v),
          }));
          resetPreferredCol();
          return;
        }
        if (keyName === "b") {
          setCursor(moveCursorHorizontally(cursorPos, this.value || "", "left"));
          resetPreferredCol();
          return;
        }
        if (keyName === "f") {
          setCursor(moveCursorHorizontally(cursorPos, this.value || "", "right"));
          resetPreferredCol();
          return;
        }
        if (keyName === "d") {
          deleteAtCursor();
          return;
        }
        if (keyName === "h") {
          deleteBeforeCursor();
          return;
        }
        if (keyName === "k") {
          deleteToBoundary("end");
          return;
        }
        if (keyName === "u") {
          deleteToBoundary("start");
          return;
        }
        if (keyName === "w") {
          const next = deleteWordBeforeCursor(this.value || "", cursorPos);
          this.value = next.value;
          cursorPos = next.cursorPos;
          resetPreferredCol();
          renderInput();
          return;
        }
      }

      if (key && key.meta) {
        if (keyName === "b") {
          setCursor(moveCursorByWord(this.value || "", cursorPos, "backward"));
          resetPreferredCol();
          return;
        }
        if (keyName === "f") {
          setCursor(moveCursorByWord(this.value || "", cursorPos, "forward"));
          resetPreferredCol();
          return;
        }
        if (keyName === "d") {
          const end = moveCursorByWord(this.value || "", cursorPos, "forward");
          replaceInputRange(cursorPos, end, "");
          return;
        }
      }

      if (keyName === "backspace") {
        if (key && (key.meta || key.ctrl)) {
          const next = deleteWordBeforeCursor(this.value || "", cursorPos);
          this.value = next.value;
          cursorPos = next.cursorPos;
          resetPreferredCol();
          renderInput();
        } else {
          deleteBeforeCursor();
        }
        return;
      }

      if (keyName === "delete") {
        if (key && key.meta) {
          deleteToBoundary("end");
        } else {
          deleteAtCursor();
        }
        return;
      }

      if (keyName === "home") {
        setCursor(moveCursorToVisualLineBoundary({
          cursorPos,
          inputValue: this.value || "",
          width: getWrapWidth(),
          boundary: "start",
          strWidth: (v) => this.strWidth(v),
        }));
        resetPreferredCol();
        return;
      }

      if (keyName === "end") {
        setCursor(moveCursorToVisualLineBoundary({
          cursorPos,
          inputValue: this.value || "",
          width: getWrapWidth(),
          boundary: "end",
          strWidth: (v) => this.strWidth(v),
        }));
        resetPreferredCol();
        return;
      }

      if (ch && ch.length > 1 && (!keyName || keyName.length !== 1)) {
        insertTextAtCursor(ch);
        return;
      }

      // Normal character insertion at cursor position
      const insertChar = (ch && ch.length === 1) ? ch : (keyName && keyName.length === 1 ? keyName : null);
      if (insertChar && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar)) {
        insertTextAtCursor(insertChar);
      }
    };

    const renderDashboard = () => {
      let hint = "No target agents";
      if (activeAgents.length > 0) {
        if (targetAgent) {
          hint = `↓ select ${getAgentLabel(targetAgent)} · ←/→ switch · ↑ clear`;
        } else {
          hint = "↓ select target · ←/→ switch";
        }
      }
      const computed = computeDashboardContent({
        focusMode: "dashboard",
        dashboardView: "agents",
        activeAgents,
        selectedAgentIndex,
        agentListWindowStart,
        maxAgentWindow: 4,
        getAgentLabel,
        dashHints: { agents: hint, agentsEmpty: hint },
      });
      agentListWindowStart = computed.windowStart;
      dashboard.setContent(computed.content);
      screen.render();
    };

    const logText = (text = "") => {
      activeToolMerge = null;
      firstToolInGroup = true; // Reset tool group flag when switching back to text
      const sanitized = stripLeakedEscapeTags(text);
      const lines = renderLogLinesWithMarkdown(
        sanitized,
        logRenderState,
        escapeBlessed
      );
      for (const line of lines) {
        logBox.log(line);
      }
      screen.render();
    };

    const logUserInput = (text = "") => {
      activeToolMerge = null;
      const line = formatHighlightedUserInput(text, {
        width: resolveLogContentWidth({ logBox, screen, fallback: (stdout && stdout.columns) || 80 }),
        escapeText: escapeBlessed,
      });
      if (!line) return;
      logBox.log(line);
      logBox.log(""); // Add line break after user input
      screen.render();
    };

    const logControlAction = (text = "") => {
      activeToolMerge = null;
      const plain = String(text || "").trim();
      if (!plain) return;
      logBox.log(`{gray-fg}⚙{/gray-fg} ${escapeBlessed(plain)}`);
      screen.render();
    };

    const summarizeToolDetail = (tool = "", args = {}, payload = {}) => {
      const toolName = String(tool || "").trim().toLowerCase();
      const argObj = args && typeof args === "object" ? args : {};
      const resObj = payload && typeof payload === "object" ? payload : {};

      if (toolName === "read") {
        const target = String(resObj.path || argObj.path || argObj.file || "").trim();
        const lineInfo = Number.isFinite(resObj.totalLines) ? `${resObj.totalLines} lines` : "";
        return [target, lineInfo].filter(Boolean).join(" · ");
      }
      if (toolName === "write") {
        const target = String(resObj.path || argObj.path || argObj.file || "").trim();
        const mode = String(resObj.mode || argObj.mode || (argObj.append ? "append" : "overwrite")).trim();
        const bytes = Number.isFinite(resObj.bytes) ? `${resObj.bytes} bytes` : "";
        return [target, mode, bytes].filter(Boolean).join(" · ");
      }
      if (toolName === "edit") {
        const target = String(resObj.path || argObj.path || argObj.file || "").trim();
        const replacements = Number.isFinite(resObj.replacements) ? `${resObj.replacements} replacements` : "";
        return [target, replacements].filter(Boolean).join(" · ");
      }
      if (toolName === "bash") {
        return normalizeBashToolCommand(argObj, resObj);
      }
      return "";
    };

    const truncateText = (text = "", maxLength = 80) => {
      const str = String(text || "");
      if (str.length <= maxLength) return str;
      return str.slice(0, maxLength - 3) + "...";
    };

    const renderSingleToolEntryLine = (entry = {}) => {
      const item = normalizeToolMergeEntry(entry);
      const marker = item.isError ? "{red-fg}•{/red-fg}" : "{cyan-fg}•{/cyan-fg}";
      const summary = buildMergedToolSummaryText([item]);
      const truncated = truncateText(summary, 100);
      return `${marker} ${escapeBlessed(truncated)}`;
    };

    const renderCollapsedToolMergeLine = (entries = []) => {
      const summary = buildMergedToolSummaryText(entries);
      const hasError = entries.some((item) => normalizeToolMergeEntry(item).isError);
      const marker = hasError ? "{red-fg}•{/red-fg}" : "{cyan-fg}•{/cyan-fg}";
      return `${marker} ${escapeBlessed(summary)} {gray-fg}(Ctrl+O expand){/gray-fg}`;
    };

    let firstToolInGroup = true;

    const logToolHint = (entry = {}, payload = {}) => {
      const tool = String(entry.tool || "").trim().toLowerCase();
      if (!tool) return;
      const resObj = payload && typeof payload === "object" ? payload : {};
      const isError = String(entry.phase || "").trim().toLowerCase() === "error" || resObj.ok === false;
      const detail = summarizeToolDetail(tool, entry.args, resObj);
      const errorText = String(entry.error || resObj.error || "").trim();

      const toolEntry = normalizeToolMergeEntry({
        tool,
        detail,
        isError,
        errorText,
      });

      if (activeToolMerge) {
        activeToolMerge.entries.push(toolEntry);
        // Only show collapsed format for 2+ tool calls
        if (activeToolMerge.entries.length === 2) {
          // Convert first single line to collapsed format
          logBox.setLine(activeToolMerge.lineIndex, renderCollapsedToolMergeLine(activeToolMerge.entries));
        } else if (activeToolMerge.entries.length > 2) {
          logBox.setLine(activeToolMerge.lineIndex, renderCollapsedToolMergeLine(activeToolMerge.entries));
        }
        if (activeToolMerge.entries.length > 1) {
          lastMergedToolGroup = activeToolMerge;
        }
      } else {
        // Add line break before first tool call
        if (firstToolInGroup) {
          logBox.log("");
          firstToolInGroup = false;
        }
        logBox.log(renderSingleToolEntryLine(toolEntry));
        activeToolMerge = {
          id: ++toolMergeId,
          lineIndex: logBox.getLines().length - 1,
          entries: [toolEntry],
          expanded: false,
        };
      }
      screen.render();
    };

    const renderSingleMarkdownLine = (rawLine = "", options = {}) => {
      const preview = Boolean(options.preview);
      const renderState = preview
        ? { inCodeBlock: Boolean(logRenderState.inCodeBlock) }
        : logRenderState;
      const rendered = renderLogLinesWithMarkdown(rawLine, renderState, escapeBlessed);
      return rendered[0] || "";
    };

    const createNlStreamState = () => {
      activeToolMerge = null;
      firstToolInGroup = true; // Reset flag for new response
      logBox.log(""); // Add empty line to start the response
      return {
        lineIndex: logBox.getLines().length - 1,
        buffer: "",
        full: "",
        seenVisibleContent: false,
      };
    };

    const appendNlStreamDelta = (streamState, delta) => {
      if (!streamState) return;
      const chunk = stripLeakedEscapeTags(String(delta || ""));
      if (!chunk) return;

      streamState.full += chunk;
      streamState.buffer += chunk;

      const parts = streamState.buffer.split("\n");
      if (parts.length > 1) {
        const completed = parts.slice(0, -1);
        for (const line of completed) {
          const hasVisible = /[^\s]/.test(line);
          if (!streamState.seenVisibleContent && !hasVisible) {
            continue;
          }
          if (hasVisible) {
            streamState.seenVisibleContent = true;
          }
          const rendered = renderSingleMarkdownLine(line);
          logBox.setLine(streamState.lineIndex, rendered);
          logBox.pushLine("");
          streamState.lineIndex = logBox.getLines().length - 1;
        }
        streamState.buffer = parts[parts.length - 1];
      }

      const previewHasVisible = /[^\s]/.test(streamState.buffer);
      if (!streamState.seenVisibleContent && !previewHasVisible) {
        return;
      }
      if (previewHasVisible) {
        streamState.seenVisibleContent = true;
      }
      const previewLine = renderSingleMarkdownLine(streamState.buffer, { preview: true });
      logBox.setLine(streamState.lineIndex, previewLine);
      screen.render();
    };

    const finalizeNlStream = (streamState) => {
      if (!streamState) return { lastChar: "" };
      streamState.buffer = stripLeakedEscapeTags(streamState.buffer);
      const rendered = renderSingleMarkdownLine(streamState.buffer);
      logBox.setLine(streamState.lineIndex, rendered);
      screen.render();
      const full = String(streamState.full || "");
      return { lastChar: full ? full.charAt(full.length - 1) : "" };
    };

    const updateStatus = (message = "", type = "thinking", options = {}) => {
      const getBackgroundSuffix = () => {
        if (!backgroundTasks || backgroundTasks.size === 0) return "";
        let running = 0;
        let done = 0;
        let failed = 0;
        for (const task of backgroundTasks.values()) {
          const status = String(task && task.status || "").trim().toLowerCase();
          if (status === "running") running += 1;
          else if (status === "done") done += 1;
          else if (status === "failed") failed += 1;
        }
        const total = running + done + failed;
        if (total <= 0) return "";
        return ` · BG ${running}/${done}/${failed}`;
      };
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      if (!message) {
        statusLine.setContent(escapeBlessed(`UCODE · Ready · Enter send · Shift/Alt+Enter newline · PgUp/PgDn log · Ctrl+O tools${getBackgroundSuffix()}`));
        screen.render();
        return;
      }
      const showTimer = Boolean(options.showTimer);
      const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
      const indicators = STATUS_INDICATORS[type] || STATUS_INDICATORS.thinking;
      statusIndex = 0;
      const draw = () => {
        const indicator = indicators[statusIndex % indicators.length];
        const timerText = showTimer
          ? ` (${formatPendingElapsed(Date.now() - startedAt)}，esc cancel)`
          : "";
        statusLine.setContent(escapeBlessed(`${indicator} ${message}${timerText}${getBackgroundSuffix()}`));
        statusIndex += 1;
        screen.render();
      };
      draw();
      if (type !== "none") {
        statusInterval = setInterval(draw, 100);
      }
    };

    const closeWithCode = (code = 0) => {
      if (closing) return;
      closing = true;
      if (autoBusTimer) {
        clearInterval(autoBusTimer);
        autoBusTimer = null;
      }
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      if (pendingTask && pendingTask.abortController && !pendingTask.abortController.signal.aborted) {
        try {
          pendingTask.abortController.abort();
        } catch {
          // ignore
        }
      }
      try {
        screen.destroy();
      } catch {
        // ignore
      }
      resolve({ code });
    };

    const runAutoBusOnce = async () => {
      if (!autoBusEnabled || closing || pendingTask) return;
      if (Number(getAutoBusPendingCount()) <= 0) {
        autoBusError = "";
        return;
      }

      // Set pending state for autoBus tasks
      const abortController = new AbortController();
      pendingTask = {
        abortController,
        startedAt: Date.now(),
      };
      updateStatus("Processing bus messages...", "thinking", {
        showTimer: true,
        startedAt: pendingTask.startedAt,
      });

      try {
        const ubusResult = await runUbusCommand(state, {
          workspaceRoot,
          subscriberId: autoBusSubscriberId,
          signal: abortController.signal,
          onMessageReceived: (msg) => {
            // Display the incoming message immediately
            const { extractAgentNickname } = require("./agent");
            const nickname = extractAgentNickname(msg.from) || msg.from;
            logText(`${nickname}: ${msg.task}`);
            // Update status to show we're working on this specific task
            updateStatus("Working on task...", "thinking", {
              showTimer: true,
              startedAt: pendingTask.startedAt,
            });
          },
        });

        if (!ubusResult.ok) {
          const nextError = String(ubusResult.error || "ubus failed");
          if (nextError !== autoBusError) {
            autoBusError = nextError;
            logText(`Error: ${nextError}`);
          }
          return;
        }
        autoBusError = "";
        if (ubusResult.handled > 0) {
          // Display only the replies (tasks were already shown via onMessageReceived)
          if (ubusResult.messageExchanges && ubusResult.messageExchanges.length > 0) {
            const { extractAgentNickname } = require("./agent");
            for (const exchange of ubusResult.messageExchanges) {
              const nickname = extractAgentNickname(exchange.from) || exchange.from;
              // Only show the reply since task was already displayed
              logText(`@${nickname} ${exchange.reply}`);
            }
          }
          const persisted = persistSessionState(state);
          if (!persisted || persisted.ok === false) {
            logText(`Error: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}`);
          }
        }
      } finally {
        // Clear pending state
        pendingTask = null;
        updateStatus("", "none");
      }
    };

    const scheduleAutoBus = () => {
      if (!autoBusEnabled || closing || autoBusQueued || pendingTask) return;
      if (Number(getAutoBusPendingCount()) <= 0) return;
      autoBusQueued = true;
      chain = chain
        .then(() => runAutoBusOnce())
        .catch(() => {})
        .finally(() => {
          autoBusQueued = false;
        });
    };

    const resolveTargetToken = (token = "") => {
      const text = String(token || "").trim();
      if (!text) return "";

      if (text.includes(":")) {
        const match = activeAgents.find((id) => id === text || id.startsWith(text));
        if (match) return match;
      }

      const normalized = text.toLowerCase();
      for (const id of activeAgents) {
        const meta = activeAgentMetaMap.get(id);
        if (!meta) continue;
        const nick = String(meta.nickname || "").toLowerCase();
        if (nick && (nick === normalized || nick.startsWith(normalized))) return id;
      }
      return "";
    };

    const executeLine = async (line) => {
      const normalizedLine = String(line || "").replace(/\r?\n/g, " ").trim();
      if (!normalizedLine) return;
      logUserInput(normalizedLine);

      refreshAgents();

      let actualLine = normalizedLine;
      let isBusMessage = false;

      if (targetAgent) {
        isBusMessage = true;
      }

      const mentionMatch = normalizedLine.match(/^@(\S+)\s+(.+)$/);
      if (mentionMatch) {
        const [, token, message] = mentionMatch;
        const resolved = resolveTargetToken(token);
        if (resolved) {
          isBusMessage = true;
          actualLine = message;
          targetAgent = resolved;
          selectedAgentIndex = activeAgents.indexOf(resolved);
          setPrompt();
          renderDashboard();
        }
      }

      if (isBusMessage && targetAgent) {
        updateStatus("Sending message...", "typing");
        try {
          execFileSync("ufoo", ["bus", "send", targetAgent, actualLine], {
            cwd: workspaceRoot,
            encoding: "utf8",
          });
          updateStatus("", "none");
          logText(`✓ Message sent to ${getAgentLabel(targetAgent)}`);
        } catch (err) {
          updateStatus("", "none");
          const msg = err && err.message ? err.message : "unknown error";
          logText(`Failed to send message: ${msg}`);
        }
        targetAgent = null;
        selectedAgentIndex = -1;
        agentSelectionMode = false;
        setPrompt();
        renderDashboard();
        return;
      }

      const runtimeWorkspace = String((state && state.workspaceRoot) || workspaceRoot || process.cwd());
      const result = runSingleCommand(actualLine, runtimeWorkspace);
      if (result.kind === "empty") return;
      if (result.kind === "exit") {
        closeWithCode(0);
        return;
      }
      if (result.kind === "tool") {
        const payload = result.result && typeof result.result === "object" ? result.result : {};
        logToolHint({
          tool: result.tool,
          args: result.args,
          phase: payload.ok === false ? "error" : "end",
          error: payload.error || "",
        }, payload);
        return;
      }
      if (result.kind === "probe") {
        return;
      }
      if (result.kind === "help" || result.kind === "error") {
        logText(result.output || "");
        return;
      }
      if (result.kind === "ubus") {
        updateStatus("Checking bus messages...", "typing");
        const ubusResult = await runUbusCommand(state, {
          workspaceRoot,
          onMessageReceived: (msg) => {
            // Display the incoming message immediately
            const { extractAgentNickname } = require("./agent");
            const nickname = extractAgentNickname(msg.from) || msg.from;
            logText(`${nickname}: ${msg.task}`);
          },
        });
        updateStatus("", "none");
        if (!ubusResult.ok) {
          logText(`Error: ${ubusResult.error}`);
          return;
        }

        // Display only the replies (tasks were already shown via onMessageReceived)
        if (ubusResult.messageExchanges && ubusResult.messageExchanges.length > 0) {
          const { extractAgentNickname } = require("./agent");
          for (const exchange of ubusResult.messageExchanges) {
            const nickname = extractAgentNickname(exchange.from) || exchange.from;
            // Only show the reply since task was already displayed
            logText(`@${nickname} ${exchange.reply}`);
          }
        } else if (ubusResult.handled === 0) {
          logText("ubus: no pending messages.");
        }
        const persisted = persistSessionState(state);
        if (!persisted || persisted.ok === false) {
          logText(`Error: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}`);
        }
        return;
      }
      if (result.kind === "resume") {
        const resumed = resumeSessionState(state, result.sessionId, workspaceRoot);
        if (!resumed.ok) {
          logText(`Error: ${resumed.error}`);
          return;
        }
        logText(`Resumed session ${resumed.sessionId} (${resumed.restoredMessages} messages).`);
        return;
      }

      if (result.kind === "nl_bg") {
        backgroundSeq += 1;
        const jobId = `bg-${Date.now().toString(36)}-${backgroundSeq.toString(36)}`;
        const taskRecord = {
          id: jobId,
          task: result.task,
          status: "running",
          startedAt: Date.now(),
          summary: "",
        };
        backgroundTasks.set(jobId, taskRecord);
        updateStatus("", "none");
        logText(`[${jobId}] started in background.`);

        const bgState = {
          workspaceRoot: state.workspaceRoot,
          provider: state.provider,
          model: state.model,
          engine: state.engine,
          context: state.context,
          nlMessages: Array.isArray(state.nlMessages) ? state.nlMessages.slice() : [],
          sessionId: "",
          timeoutMs: state.timeoutMs,
          jsonOutput: false,
        };

        Promise.resolve()
          .then(() => runNaturalLanguageTask(result.task, bgState))
          .then((nlResult) => {
            taskRecord.status = nlResult && nlResult.ok ? "done" : "failed";
            taskRecord.finishedAt = Date.now();
            taskRecord.summary = String(formatNlResult(nlResult, false) || "").trim();
            const title = taskRecord.status === "done" ? "done" : "failed";
            logText(`[${jobId}] ${title}: ${taskRecord.summary || "no summary"}`);
          })
          .catch((err) => {
            taskRecord.status = "failed";
            taskRecord.finishedAt = Date.now();
            taskRecord.summary = err && err.message ? String(err.message) : "background task failed";
            logText(`[${jobId}] failed: ${taskRecord.summary}`);
          })
          .finally(() => {
            updateStatus("", "none");
            screen.render();
          });
        return;
      }

      if (result.kind === "nl") {
        const abortController = new AbortController();
        const escapeStripper = createEscapeTagStripper();
        pendingTask = {
          abortController,
          startedAt: Date.now(),
        };
        const TOOL_LABELS = {
          read: "Reading file",
          write: "Writing file",
          edit: "Editing file",
          bash: "Running command",
        };
        const setNlStatus = (msg) => {
          updateStatus(msg, "thinking", {
            showTimer: true,
            startedAt: pendingTask.startedAt,
          });
        };
        setNlStatus("Waiting for model...");
        let streamState = null;
        let renderedToolLogCount = 0;
        let nlResult = null;
        try {
          nlResult = await runNaturalLanguageTask(result.task, state, {
            signal: abortController.signal,
            onPhase: (event) => {
              if (!event || typeof event !== "object") return;
              if (event.type === "request_start") {
                setNlStatus("Waiting for model...");
              } else if (event.type === "thinking_delta") {
                setNlStatus("Thinking...");
              } else if (event.type === "text_delta") {
                setNlStatus("Generating response...");
              } else if (event.type === "tool_request") {
                const label = TOOL_LABELS[String(event.name || "").toLowerCase()] || `Calling ${event.name}`;
                setNlStatus(`${label}...`);
              }
            },
            onDelta: (delta) => {
              const text = escapeStripper.write(String(delta || ""));
              if (!text) return;
              if (!streamState) {
                streamState = createNlStreamState();
              }
              appendNlStreamDelta(streamState, text);
            },
            onToolLog: (entry) => {
              renderedToolLogCount += 1;
              if (entry && entry.tool && entry.phase === "start") {
                const label = TOOL_LABELS[String(entry.tool || "").toLowerCase()] || `Calling ${entry.tool}`;
                setNlStatus(`${label}...`);
              }
              logToolHint(entry);
            },
          });
          const tail = escapeStripper.flush();
          if (tail) {
            if (!streamState) {
              streamState = createNlStreamState();
            }
            appendNlStreamDelta(streamState, tail);
          }
          let finalStreamInfo = { lastChar: "" };
          if (streamState) {
            finalStreamInfo = finalizeNlStream(streamState);
          }
          if (Array.isArray(nlResult && nlResult.logs) && nlResult.logs.length > renderedToolLogCount) {
            for (const entry of nlResult.logs.slice(renderedToolLogCount)) {
              logToolHint(entry);
            }
          }
          const streamed = Boolean(nlResult && nlResult.streamed);
          const hasVisibleStreamText = Boolean(
            streamState
            && typeof streamState.full === "string"
            && /[^\s]/.test(streamState.full)
          );
          const streamLastChar = nlResult && typeof nlResult.streamLastChar === "string"
            ? nlResult.streamLastChar.slice(-1)
            : finalStreamInfo.lastChar;
          if (streamed && hasVisibleStreamText && streamLastChar !== "\n") {
            logBox.log("");
            screen.render();
          }
          const shouldSkipSummary = Boolean(streamed && nlResult && nlResult.ok && hasVisibleStreamText);
          if (!shouldSkipSummary) {
            logText(formatNlResult(nlResult, false));
          }
          const persisted = persistSessionState(state);
          if (!persisted || persisted.ok === false) {
            logText(`Error: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}`);
          }
        } finally {
          pendingTask = null;
          updateStatus("", "none");
        }
      }
    };

    const submitInput = (value = "") => {
      const raw = String(value || "");
      const trimmed = raw.trim();
      input.setValue("");
      cursorPos = 0;
      resetPreferredCol();
      resizeInput();
      screen.render();
      agentSelectionMode = false;

      if (trimmed) {
        inputHistory.push(trimmed);
      }
      historyIndex = inputHistory.length;

      chain = chain
        .then(() => executeLine(raw))
        .catch((err) => {
          updateStatus("", "none");
          logText(`Error: ${err && err.message ? err.message : "agent loop failed"}`);
        })
        .finally(() => {
          if (closing) return;
          refreshAgents();
          setPrompt();
          renderDashboard();
          input.focus();
          screen.render();
        });
    };

    input.key(["enter"], (ch, key) => {
      if (skipSubmitKeyRef && (!key || skipSubmitKeyRef === key || skipSubmitKeyRef === true)) {
        skipSubmitKeyRef = null;
        return false;
      }
      submitInput(input.getValue());
      return false;
    });
    input.key(["up"], () => {
      const currentValue = input.getValue();
      if (shouldClearAgentSelectionOnUp({
        agentSelectionMode,
        inputValue: currentValue,
      })) {
        targetAgent = null;
        selectedAgentIndex = -1;
        agentSelectionMode = false;
        setPrompt();
        renderDashboard();
        // Target selection cleared - removed redundant log
        input.focus();
        return false;
      }
      if (currentValue) {
        const move = moveCursorVertically({
          cursorPos,
          inputValue: currentValue,
          width: getWrapWidth(),
          direction: "up",
          preferredCol,
          strWidth: (v) => input.strWidth(v),
        });
        preferredCol = move.preferredCol;
        if (move.moved) {
          setCursor(move.nextCursorPos);
          return false;
        }
      }
      if (inputHistory.length === 0) return false;
      historyIndex = Math.max(0, historyIndex - 1);
      setInputValue(inputHistory[historyIndex] || "");
      return false;
    });
    input.key(["down"], () => {
      const currentValue = input.getValue();
      if (currentValue) {
        const move = moveCursorVertically({
          cursorPos,
          inputValue: currentValue,
          width: getWrapWidth(),
          direction: "down",
          preferredCol,
          strWidth: (v) => input.strWidth(v),
        });
        preferredCol = move.preferredCol;
        if (move.moved) {
          setCursor(move.nextCursorPos);
          return false;
        }
      }
      const historyTransition = resolveHistoryDownTransition({
        inputHistory,
        historyIndex,
        currentValue,
      });
      if (historyTransition.moved) {
        historyIndex = historyTransition.nextHistoryIndex;
        setInputValue(historyTransition.nextValue);
        return false;
      }

      if (shouldEnterAgentSelection(currentValue)) {
        const cachedAgents = Array.isArray(activeAgents) ? activeAgents.slice() : [];
        const cachedMeta = activeAgentMetaMap instanceof Map ? new Map(activeAgentMetaMap) : new Map();
        if (!agentSelectionMode) {
          refreshAgents();
        }
        if (!agentSelectionMode && activeAgents.length === 0 && cachedAgents.length > 0) {
          activeAgents = cachedAgents;
          activeAgentMetaMap = cachedMeta;
        }
        const decision = resolveAgentSelectionOnDown({
          agentSelectionMode,
          selectedAgentIndex,
          totalAgents: activeAgents.length,
        });
        if (decision.action === "enter") {
          selectedAgentIndex = decision.index;
          targetAgent = activeAgents[selectedAgentIndex];
          agentSelectionMode = true;
          setPrompt();
          renderDashboard();
          // Removed redundant target selection log
          input.focus();
          return false;
        }
        if (decision.action === "hold") {
          return false;
        }
      }
      return false;
    });
    input.key(["left"], () => {
      const currentValue = input.getValue();
      if (agentSelectionMode && shouldEnterAgentSelection(currentValue)) {
        if (activeAgents.length === 0) refreshAgents();
        if (activeAgents.length === 0) return false;
        selectedAgentIndex = cycleAgentSelectionIndex(selectedAgentIndex, activeAgents.length, "left");
        targetAgent = activeAgents[selectedAgentIndex];
        setPrompt();
        renderDashboard();
        // Removed redundant target switch log
        input.focus();
        return false;
      }
      const next = moveCursorHorizontally(cursorPos, currentValue, "left");
      if (next !== cursorPos) {
        setCursor(next);
        resetPreferredCol();
      }
      return false;
    });
    input.key(["right"], () => {
      const currentValue = input.getValue();
      if (agentSelectionMode && shouldEnterAgentSelection(currentValue)) {
        if (activeAgents.length === 0) refreshAgents();
        if (activeAgents.length === 0) return false;
        selectedAgentIndex = cycleAgentSelectionIndex(selectedAgentIndex, activeAgents.length, "right");
        targetAgent = activeAgents[selectedAgentIndex];
        setPrompt();
        renderDashboard();
        // Removed redundant target switch log
        input.focus();
        return false;
      }
      const next = moveCursorHorizontally(cursorPos, currentValue, "right");
      if (next !== cursorPos) {
        setCursor(next);
        resetPreferredCol();
      }
      return false;
    });

    screen.key(["tab"], () => {
      refreshAgents();
      if (activeAgents.length === 0) return;
      if (selectedAgentIndex < 0) selectedAgentIndex = 0;
      else selectedAgentIndex = (selectedAgentIndex + 1) % activeAgents.length;
      targetAgent = activeAgents[selectedAgentIndex];
      agentSelectionMode = true;
      setPrompt();
      renderDashboard();
      // Removed redundant target switch log
      input.focus();
    });
    screen.key(["S-tab"], () => {
      refreshAgents();
      if (activeAgents.length === 0) return;
      if (selectedAgentIndex < 0) selectedAgentIndex = 0;
      else selectedAgentIndex = (selectedAgentIndex - 1 + activeAgents.length) % activeAgents.length;
      targetAgent = activeAgents[selectedAgentIndex];
      agentSelectionMode = true;
      setPrompt();
      renderDashboard();
      // Removed redundant target switch log
      input.focus();
    });
    screen.key(["C-o"], () => {
      if (!lastMergedToolGroup || lastMergedToolGroup.expanded) return;
      if (!Array.isArray(lastMergedToolGroup.entries) || lastMergedToolGroup.entries.length < 2) return;
      const lines = buildMergedToolExpandedLines(lastMergedToolGroup.entries);
      for (let i = 0; i < lines.length; i += 1) {
        const branch = i === lines.length - 1 ? "└" : "│";
        logBox.log(`{gray-fg}${branch}{/gray-fg} ${escapeBlessed(lines[i])}`);
      }
      lastMergedToolGroup.expanded = true;
      if (activeToolMerge && activeToolMerge.id === lastMergedToolGroup.id) {
        activeToolMerge = null;
      }
      screen.render();
    });
    screen.key(["pageup"], () => {
      logBox.scroll(-Math.max(1, Math.floor((logBox.height || 10) / 2)));
      screen.render();
    });
    screen.key(["pagedown"], () => {
      logBox.scroll(Math.max(1, Math.floor((logBox.height || 10) / 2)));
      screen.render();
    });
    input.key(["escape"], () => {
      if (pendingTask && pendingTask.abortController && !pendingTask.abortController.signal.aborted) {
        try {
          pendingTask.abortController.abort();
        } catch {
          // ignore
        }
        logControlAction("Cancellation requested. Stopping the current task...");
        updateStatus("Cancelling...", "waiting", {
          showTimer: true,
          startedAt: pendingTask.startedAt,
        });
        return false;
      }
      targetAgent = null;
      selectedAgentIndex = -1;
      agentSelectionMode = false;
      setInputValue("");
      setPrompt();
      renderDashboard();
      // Target selection cleared - removed redundant log
      input.focus();
      return false;
    });
    screen.key(["C-c"], () => closeWithCode(0));
    screen.on("resize", () => {
      renderDashboard();
      screen.render();
    });

    const nickname = process.env.UFOO_NICKNAME || "";
    const subscriberId = currentSubscriberId;
    const agentId = subscriberId.includes(":") ? subscriberId.split(":")[1] : "";
    const bannerLines = buildUcodeBannerBlessedLines({
      model: state.model || process.env.UFOO_UCODE_MODEL || "",
      engine: state.engine || "ufoo-core",
      nickname,
      agentId,
      workspaceRoot,
      sessionId: state.sessionId || "",
      width: (stdout && stdout.columns) || 80,
    });
    for (const line of bannerLines) {
      logBox.log(String(line || ""));
    }
    logBox.log("");

    refreshAgents();
    setPrompt();
    updateStatus("", "none");
    renderDashboard();
    if (autoBusEnabled) {
      autoBusTimer = setInterval(() => {
        scheduleAutoBus();
      }, 800);
      scheduleAutoBus();
    }
    input.focus();
    screen.render();
  });
}

module.exports = {
  UCODE_BANNER_LINES,
  UCODE_VERSION,
  StreamBuffer,
  displayCellWidth,
  resolveLogContentWidth,
  formatHighlightedUserInput,
  buildUcodeBannerLines,
  buildUcodeBannerBlessedLines,
  parseActiveAgentsFromBusStatus,
  shouldUseUcodeTui,
  renderLogLinesWithMarkdown,
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
  createEscapeTagStripper,
  formatPendingElapsed,
  normalizeBashToolCommand,
  normalizeToolMergeEntry,
  buildMergedToolSummaryText,
  buildMergedToolExpandedLines,
  runUcodeTui,
};
