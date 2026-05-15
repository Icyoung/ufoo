function createInputListenerController(options = {}) {
  const {
    getCurrentView = () => "main",
    exitHandler = () => {},
    getFocusMode = () => "input",
    getDashboardView = () => "agents",
    getSelectedAgentIndex = () => -1,
    getActiveAgents = () => [],
    getTargetAgent = () => null,
    getGlobalScope = () => "",
    clearTargetAgent = () => {},
    exitProjectScope = () => {},
    requestCloseAgent = () => {},
    logMessage = () => {},
    isSuppressKeypress = () => false,
    normalizeCommandPrefix = () => {},
    handleDashboardKey = () => false,
    exitDashboardMode = () => {},
    completionController,
    getLogHeight = () => 10,
    scrollLog = () => {},
    insertTextAtCursor = () => {},
    normalizePaste = (text) => text,
    resetPreferredCol = () => {},
    getCursorPos = () => 0,
    setCursorPos = () => {},
    ensureInputCursorVisible = () => {},
    getWrapWidth = () => 0,
    getCursorRowCol = () => ({ row: 0, col: 0 }),
    countLines = () => 1,
    getCursorPosForRowCol = () => 0,
    getPreferredCol = () => null,
    setPreferredCol = () => {},
    historyUp = () => false,
    historyDown = () => false,
    enterDashboardMode = () => {},
    resizeInput = () => {},
    updateDraftFromInput = () => {},
  } = options;

  if (!completionController) {
    throw new Error("createInputListenerController requires completionController");
  }

  function shouldShowCompletion(value = "") {
    const text = String(value || "");
    return text.startsWith("/") || text.startsWith("@");
  }

  function render(textarea) {
    if (textarea && textarea.screen && typeof textarea.screen.render === "function") {
      textarea.screen.render();
    }
  }

  function updateCursor(textarea) {
    if (textarea && typeof textarea._updateCursor === "function") {
      textarea._updateCursor();
    }
  }

  function clampCursorPos(pos = 0, value = "") {
    const text = String(value || "");
    const normalized = Number.isFinite(pos) ? Math.floor(pos) : 0;
    return Math.max(0, Math.min(text.length, normalized));
  }

  function refreshAfterEdit(textarea) {
    resizeInput();
    ensureInputCursorVisible();
    updateCursor(textarea);
    updateDraftFromInput();

    if (textarea && shouldShowCompletion(textarea.value)) {
      completionController.show(textarea.value);
    } else {
      completionController.hide();
    }

    render(textarea);
  }

  function replaceInputRange(textarea, start, end, replacement = "") {
    if (!textarea) return;
    const value = String(textarea.value || "");
    const safeStart = clampCursorPos(start, value);
    const safeEnd = clampCursorPos(end, value);
    const from = Math.min(safeStart, safeEnd);
    const to = Math.max(safeStart, safeEnd);
    const insert = String(replacement || "");
    textarea.value = value.slice(0, from) + insert + value.slice(to);
    setCursorPos(from + insert.length);
    resetPreferredCol();
    refreshAfterEdit(textarea);
  }

  function deleteWordBefore(textarea) {
    const value = String((textarea && textarea.value) || "");
    const cursorPos = clampCursorPos(getCursorPos(), value);
    if (cursorPos <= 0) return;
    const before = value.slice(0, cursorPos);
    const match = before.match(/\s*\S+\s*$/);
    const start = match ? cursorPos - match[0].length : Math.max(0, cursorPos - 1);
    replaceInputRange(textarea, start, cursorPos, "");
  }

  function moveCursorByWord(textarea, direction = "forward") {
    const value = String((textarea && textarea.value) || "");
    const cursorPos = clampCursorPos(getCursorPos(), value);
    if (direction === "backward") {
      const before = value.slice(0, cursorPos);
      const trimmedEnd = before.search(/\S\s*$/) >= 0 ? before.replace(/\s+$/, "") : before;
      const match = trimmedEnd.match(/\S+$/);
      return match ? trimmedEnd.length - match[0].length : 0;
    }
    const after = value.slice(cursorPos);
    const match = after.match(/^\s*\S+/);
    return match ? Math.min(value.length, cursorPos + match[0].length) : value.length;
  }

  function moveCursorToVisualBoundary(textarea, boundary = "start") {
    const width = getWrapWidth();
    const value = String((textarea && textarea.value) || "");
    if (width <= 0) return boundary === "end" ? value.length : 0;
    const cursorPos = clampCursorPos(getCursorPos(), value);
    const { row } = getCursorRowCol(value, cursorPos, width);
    const targetCol = boundary === "end" ? width : 0;
    return getCursorPosForRowCol(value, row, targetCol, width);
  }

  function setCursorAndRender(textarea, nextPos) {
    setCursorPos(clampCursorPos(nextPos, (textarea && textarea.value) || ""));
    ensureInputCursorVisible();
    updateCursor(textarea);
    render(textarea);
  }

  function handleKey(ch, key = {}, textarea) {
    const keyName = key && key.name;

    if (getCurrentView() === "agent") return;

    if (key && key.ctrl && keyName === "c") {
      exitHandler();
      return;
    }

    if (key && key.ctrl && keyName === "x") {
      const focusMode = getFocusMode();
      const dashboardView = getDashboardView();
      if (focusMode === "dashboard" && dashboardView !== "agents") {
        handleDashboardKey(key);
        return;
      }
      const selectedAgentIndex = getSelectedAgentIndex();
      const activeAgents = getActiveAgents();
      const targetAgent = getTargetAgent();
      if (
        focusMode === "dashboard" &&
        dashboardView === "agents" &&
        selectedAgentIndex >= 0 &&
        selectedAgentIndex < activeAgents.length
      ) {
        requestCloseAgent(activeAgents[selectedAgentIndex]);
      } else if (targetAgent) {
        requestCloseAgent(targetAgent);
      } else {
        logMessage("error", "{white-fg}✗{/white-fg} No agent selected");
      }
      return;
    }

    if (isSuppressKeypress()) {
      return;
    }

    normalizeCommandPrefix();

    if (getFocusMode() === "dashboard") {
      if (handleDashboardKey(key)) return;
      const dashboardView = getDashboardView();
      if (
        dashboardView === "agents" &&
        ch &&
        ch.length === 1 &&
        !(key && key.ctrl) &&
        !(key && key.meta) &&
        !/^[\x00-\x1f\x7f]$/.test(ch)
      ) {
        exitDashboardMode(true);
      } else {
        return;
      }
    }

    if (completionController.isActive() && completionController.handleKey(ch, key)) return;

    if (keyName === "pageup" || keyName === "pagedown") {
      const delta = Math.max(1, Math.floor(getLogHeight() / 2));
      scrollLog(keyName === "pageup" ? -delta : delta);
      return;
    }

    if (ch && ch.length > 1 && (!keyName || keyName.length !== 1)) {
      insertTextAtCursor(normalizePaste(ch));
      return;
    }

    if (ch && (ch.includes("\n") || ch.includes("\r")) && (keyName !== "return" && keyName !== "enter")) {
      insertTextAtCursor(normalizePaste(ch));
      return;
    }

    if (keyName === "return" || keyName === "enter") {
      const value = String((textarea && textarea.value) || "");
      const cursorPos = clampCursorPos(getCursorPos(), value);
      if (key && (key.shift || key.meta)) {
        insertTextAtCursor("\n");
      } else if (cursorPos > 0 && value[cursorPos - 1] === "\\") {
        replaceInputRange(textarea, cursorPos - 1, cursorPos, "\n");
      } else {
        resetPreferredCol();
        if (textarea && typeof textarea._done === "function") {
          textarea._done(null, textarea.value);
        }
      }
      return;
    }

    if (key && key.ctrl) {
      if (keyName === "a") {
        setCursorAndRender(textarea, moveCursorToVisualBoundary(textarea, "start"));
        resetPreferredCol();
        return;
      }
      if (keyName === "e") {
        setCursorAndRender(textarea, moveCursorToVisualBoundary(textarea, "end"));
        resetPreferredCol();
        return;
      }
      if (keyName === "b") {
        const cursorPos = getCursorPos();
        if (cursorPos > 0) setCursorAndRender(textarea, cursorPos - 1);
        resetPreferredCol();
        return;
      }
      if (keyName === "f") {
        const cursorPos = getCursorPos();
        const value = String((textarea && textarea.value) || "");
        if (cursorPos < value.length) setCursorAndRender(textarea, cursorPos + 1);
        resetPreferredCol();
        return;
      }
      if (keyName === "d") {
        const cursorPos = getCursorPos();
        const value = String((textarea && textarea.value) || "");
        if (cursorPos < value.length) replaceInputRange(textarea, cursorPos, cursorPos + 1, "");
        return;
      }
      if (keyName === "h") {
        const cursorPos = getCursorPos();
        if (cursorPos > 0) replaceInputRange(textarea, cursorPos - 1, cursorPos, "");
        return;
      }
      if (keyName === "k") {
        const cursorPos = getCursorPos();
        const value = String((textarea && textarea.value) || "");
        const target = moveCursorToVisualBoundary(textarea, "end");
        if (target === cursorPos && value[cursorPos] === "\n") {
          replaceInputRange(textarea, cursorPos, cursorPos + 1, "");
        } else {
          replaceInputRange(textarea, cursorPos, target, "");
        }
        return;
      }
      if (keyName === "u") {
        const cursorPos = getCursorPos();
        const value = String((textarea && textarea.value) || "");
        const target = moveCursorToVisualBoundary(textarea, "start");
        if (target === cursorPos && value[cursorPos - 1] === "\n") {
          replaceInputRange(textarea, cursorPos - 1, cursorPos, "");
        } else {
          replaceInputRange(textarea, target, cursorPos, "");
        }
        return;
      }
      if (keyName === "w") {
        deleteWordBefore(textarea);
        return;
      }
    }

    if (key && key.meta) {
      if (keyName === "b") {
        setCursorAndRender(textarea, moveCursorByWord(textarea, "backward"));
        resetPreferredCol();
        return;
      }
      if (keyName === "f") {
        setCursorAndRender(textarea, moveCursorByWord(textarea, "forward"));
        resetPreferredCol();
        return;
      }
      if (keyName === "d") {
        const cursorPos = getCursorPos();
        replaceInputRange(textarea, cursorPos, moveCursorByWord(textarea, "forward"), "");
        return;
      }
    }

    if (keyName === "left") {
      const cursorPos = getCursorPos();
      if (cursorPos > 0) setCursorPos(cursorPos - 1);
      resetPreferredCol();
      ensureInputCursorVisible();
      updateCursor(textarea);
      render(textarea);
      return;
    }

    if (keyName === "right") {
      const cursorPos = getCursorPos();
      if (cursorPos < (textarea && textarea.value ? textarea.value.length : 0)) {
        setCursorPos(cursorPos + 1);
      }
      resetPreferredCol();
      ensureInputCursorVisible();
      updateCursor(textarea);
      render(textarea);
      return;
    }

    if (keyName === "home") {
      setCursorAndRender(textarea, moveCursorToVisualBoundary(textarea, "start"));
      resetPreferredCol();
      return;
    }

    if (keyName === "end") {
      setCursorAndRender(textarea, moveCursorToVisualBoundary(textarea, "end"));
      resetPreferredCol();
      return;
    }

    if (keyName === "up") {
      if (completionController.isActive() && textarea && textarea.value === "/" && getCursorPos() === 1) {
        completionController.jumpToLast();
        return;
      }
    }

    if (keyName === "up" || keyName === "down") {
      const innerWidth = getWrapWidth();
      if (innerWidth <= 0) {
        if (keyName === "down") {
          enterDashboardMode();
          return;
        }
        ensureInputCursorVisible();
        updateCursor(textarea);
        render(textarea);
        return;
      }

      const cursorPos = getCursorPos();
      const value = (textarea && textarea.value) || "";
      if (!value) {
        if (keyName === "up") {
          if (historyUp()) completionController.hide();
          return;
        }
        if (historyDown()) {
          completionController.hide();
          return;
        }
        enterDashboardMode();
        return;
      }
      const { row, col } = getCursorRowCol(value, cursorPos, innerWidth);
      if (getPreferredCol() === null) setPreferredCol(col);
      const totalRows = countLines(value, innerWidth);

      if (keyName === "up" && row <= 0) {
        if (historyUp()) {
          completionController.hide();
        }
        return;
      }

      if (keyName === "down" && row >= totalRows - 1) {
        if (historyDown()) {
          completionController.hide();
          return;
        }
        enterDashboardMode();
        return;
      }

      const targetRow = keyName === "up"
        ? Math.max(0, row - 1)
        : Math.min(totalRows - 1, row + 1);
      setCursorPos(getCursorPosForRowCol(value, targetRow, getPreferredCol(), innerWidth));

      ensureInputCursorVisible();
      updateCursor(textarea);
      render(textarea);
      return;
    }

    if (keyName === "escape") {
      // Layer 1: clear @target agent
      if (getTargetAgent && getTargetAgent()) {
        clearTargetAgent();
        return;
      }
      // Layer 2: exit project scope → global scope
      if (getGlobalScope && getGlobalScope() === "project") {
        exitProjectScope();
        return;
      }
      // Layer 3: existing behavior (cancel input)
      if (textarea && typeof textarea._done === "function") {
        textarea._done(null, null);
      }
      return;
    }

    if (keyName === "backspace") {
      const cursorPos = getCursorPos();
      if (cursorPos > 0 && textarea) {
        if (key && (key.ctrl || key.meta)) {
          deleteWordBefore(textarea);
        } else {
          replaceInputRange(textarea, cursorPos - 1, cursorPos, "");
        }
      }
      return;
    }

    if (keyName === "delete") {
      const cursorPos = getCursorPos();
      if (textarea && cursorPos < textarea.value.length) {
        if (key && key.meta) {
          replaceInputRange(textarea, cursorPos, moveCursorToVisualBoundary(textarea, "end"), "");
        } else {
          replaceInputRange(textarea, cursorPos, cursorPos + 1, "");
        }
      }
      return;
    }

    const insertChar = (ch && ch.length === 1)
      ? ch
      : (keyName && keyName.length === 1 ? keyName : null);

    if (insertChar && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar) && textarea) {
      const cursorPos = getCursorPos();
      normalizeCommandPrefix();
      replaceInputRange(textarea, cursorPos, cursorPos, insertChar);
    }
  }

  return {
    handleKey,
  };
}

module.exports = {
  createInputListenerController,
};
