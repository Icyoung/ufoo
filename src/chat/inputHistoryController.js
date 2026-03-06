const fs = require("fs");

function createInputHistoryController(options = {}) {
  const {
    inputHistoryFile: inputHistoryFileOption,
    historyDir: historyDirOption,
    setInputValue = () => {},
    getInputValue = () => "",
    fsMod = fs,
  } = options;

  if (!inputHistoryFileOption || !historyDirOption) {
    throw new Error("createInputHistoryController requires inputHistoryFile and historyDir");
  }
  let inputHistoryFile = inputHistoryFileOption;
  let historyDir = historyDirOption;

  const inputHistory = [];
  let historyIndex = 0;
  let historyDraft = "";

  function appendInputHistory(text) {
    if (!text) return;
    fsMod.mkdirSync(historyDir, { recursive: true });
    fsMod.appendFileSync(inputHistoryFile, `${JSON.stringify({ text })}\n`);
  }

  function loadInputHistory(limit = 2000) {
    inputHistory.length = 0;
    historyIndex = 0;
    historyDraft = "";
    try {
      const raw = fsMod.readFileSync(inputHistoryFile, "utf8");
      const lines = String(raw || "").trim().split(/\r?\n/).filter(Boolean);
      const items = lines.slice(-limit).map((line) => JSON.parse(line));
      for (const item of items) {
        if (item && typeof item.text === "string" && item.text.trim() !== "") {
          inputHistory.push(item.text);
        }
      }
    } catch {
      // ignore missing/invalid history
    }
    historyIndex = inputHistory.length;
  }

  function updateDraftFromInput() {
    if (historyIndex === inputHistory.length) {
      historyDraft = getInputValue();
    }
  }

  function setIndexToEnd() {
    historyIndex = inputHistory.length;
    historyDraft = "";
  }

  function historyUp() {
    if (inputHistory.length === 0) return false;
    if (historyIndex === inputHistory.length) {
      historyDraft = getInputValue();
    }
    if (historyIndex > 0) {
      historyIndex -= 1;
      setInputValue(inputHistory[historyIndex]);
      return true;
    }
    return true;
  }

  function historyDown() {
    if (inputHistory.length === 0) return false;
    if (historyIndex < inputHistory.length - 1) {
      historyIndex += 1;
      setInputValue(inputHistory[historyIndex]);
      return true;
    }
    if (historyIndex === inputHistory.length - 1) {
      historyIndex = inputHistory.length;
      setInputValue(historyDraft || "");
      return true;
    }
    return false;
  }

  function commitSubmittedText(text) {
    if (!text) return;
    inputHistory.push(text);
    appendInputHistory(text);
    setIndexToEnd();
  }

  function setHistoryTarget(next = {}) {
    if (!next.inputHistoryFile || !next.historyDir) {
      throw new Error("setHistoryTarget requires inputHistoryFile and historyDir");
    }
    inputHistoryFile = next.inputHistoryFile;
    historyDir = next.historyDir;
  }

  function restoreDraft(draft = "") {
    const nextDraft = String(draft || "");
    setInputValue(nextDraft);
    historyIndex = inputHistory.length;
    historyDraft = nextDraft;
  }

  function getDraftForPersistence() {
    if (historyIndex === inputHistory.length) {
      return String(getInputValue() || "");
    }
    return String(historyDraft || "");
  }

  return {
    loadInputHistory,
    updateDraftFromInput,
    historyUp,
    historyDown,
    commitSubmittedText,
    setIndexToEnd,
    setHistoryTarget,
    restoreDraft,
    getDraftForPersistence,
    getState: () => ({
      history: [...inputHistory],
      historyIndex,
      historyDraft,
    }),
  };
}

module.exports = {
  createInputHistoryController,
};
