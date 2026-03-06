function createInputListenerController(options = {}) {
  const {
    getCurrentView = () => "main",
    exitHandler = () => {},
    getFocusMode = () => "input",
    getDashboardView = () => "agents",
    getSelectedAgentIndex = () => -1,
    getActiveAgents = () => [],
    getTargetAgent = () => null,
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
      if (key && key.shift) {
        insertTextAtCursor("\n");
      } else {
        resetPreferredCol();
        if (textarea && typeof textarea._done === "function") {
          textarea._done(null, textarea.value);
        }
      }
      return;
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
      setCursorPos(0);
      resetPreferredCol();
      ensureInputCursorVisible();
      updateCursor(textarea);
      render(textarea);
      return;
    }

    if (keyName === "end") {
      setCursorPos((textarea && textarea.value ? textarea.value.length : 0));
      resetPreferredCol();
      ensureInputCursorVisible();
      updateCursor(textarea);
      render(textarea);
      return;
    }

    if (keyName === "up") {
      if (completionController.isActive() && textarea && textarea.value === "/" && getCursorPos() === 1) {
        completionController.jumpToLast();
        return;
      }
      if (historyUp()) {
        completionController.hide();
        return;
      }
    }

    if (keyName === "down") {
      if (historyDown()) {
        completionController.hide();
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
      const { row, col } = getCursorRowCol(value, cursorPos, innerWidth);
      if (getPreferredCol() === null) setPreferredCol(col);
      const totalRows = countLines(value, innerWidth);

      if (keyName === "down" && row >= totalRows - 1) {
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
      if (textarea && typeof textarea._done === "function") {
        textarea._done(null, null);
      }
      return;
    }

    if (keyName === "backspace") {
      const cursorPos = getCursorPos();
      if (cursorPos > 0 && textarea) {
        textarea.value = textarea.value.slice(0, cursorPos - 1) + textarea.value.slice(cursorPos);
        setCursorPos(cursorPos - 1);
        resetPreferredCol();
        resizeInput();
        ensureInputCursorVisible();
        updateCursor(textarea);
        updateDraftFromInput();

        if (shouldShowCompletion(textarea.value)) {
          completionController.show(textarea.value);
        } else {
          completionController.hide();
        }

        render(textarea);
      }
      return;
    }

    if (keyName === "delete") {
      const cursorPos = getCursorPos();
      if (textarea && cursorPos < textarea.value.length) {
        textarea.value = textarea.value.slice(0, cursorPos) + textarea.value.slice(cursorPos + 1);
        resetPreferredCol();
        resizeInput();
        ensureInputCursorVisible();
        updateCursor(textarea);
        render(textarea);
        updateDraftFromInput();
      }
      return;
    }

    const insertChar = (ch && ch.length === 1)
      ? ch
      : (keyName && keyName.length === 1 ? keyName : null);

    if (insertChar && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar) && textarea) {
      const cursorPos = getCursorPos();
      textarea.value = textarea.value.slice(0, cursorPos) + insertChar + textarea.value.slice(cursorPos);
      setCursorPos(cursorPos + 1);
      normalizeCommandPrefix();
      resetPreferredCol();
      resizeInput();
      updateCursor(textarea);
      updateDraftFromInput();

      if (shouldShowCompletion(textarea.value)) {
        completionController.show(textarea.value);
      } else if (completionController.isActive()) {
        completionController.hide();
      }

      render(textarea);
    }
  }

  return {
    handleKey,
  };
}

module.exports = {
  createInputListenerController,
};
