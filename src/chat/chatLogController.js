function createChatLogController(options = {}) {
  const {
    logBox,
    fsModule,
    historyDir: historyDirOption,
    historyFile: historyFileOption,
    now = () => new Date().toISOString(),
  } = options;

  if (!logBox || typeof logBox.log !== "function") {
    throw new Error("createChatLogController requires logBox.log");
  }
  if (!fsModule) {
    throw new Error("createChatLogController requires fsModule");
  }
  if (!historyDirOption || !historyFileOption) {
    throw new Error("createChatLogController requires historyDir/historyFile");
  }
  let historyDir = historyDirOption;
  let historyFile = historyFileOption;

  const SPACED_TYPES = new Set(["user", "reply", "bus", "dispatch", "error"]);
  let lastLogWasSpacer = false;
  let hasLoggedAny = false;

  function appendHistory(entry) {
    fsModule.mkdirSync(historyDir, { recursive: true });
    fsModule.appendFileSync(historyFile, `${JSON.stringify(entry)}\n`);
  }

  function shouldSpace(type, text) {
    if (SPACED_TYPES.has(type)) return true;
    if (typeof text === "string" && /daemon/i.test(text)) return true;
    return false;
  }

  function writeSpacer(writeHistory = true) {
    if (lastLogWasSpacer || !hasLoggedAny) return;
    logBox.log(" ");
    if (writeHistory) {
      appendHistory({
        ts: now(),
        type: "spacer",
        text: "",
        meta: {},
      });
    }
    lastLogWasSpacer = true;
    hasLoggedAny = true;
  }

  function recordLog(type, text, meta = {}, writeHistory = true) {
    if (type !== "spacer" && shouldSpace(type, text)) {
      writeSpacer(writeHistory);
    }
    logBox.log(text);
    if (writeHistory) {
      appendHistory({
        ts: now(),
        type,
        text,
        meta,
      });
    }
    lastLogWasSpacer = false;
    hasLoggedAny = true;
  }

  function logMessage(type, text, meta = {}) {
    recordLog(type, text, meta, true);
  }

  function markStreamStart() {
    lastLogWasSpacer = false;
    hasLoggedAny = true;
  }

  function loadHistory(limit = 2000) {
    try {
      const raw = fsModule.readFileSync(historyFile, "utf8").trim();
      if (!raw) return;
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const items = lines.slice(-limit).map((line) => JSON.parse(line));
      const hasSpacer = items.some((item) => item && item.type === "spacer");
      for (const item of items) {
        if (!item) continue;
        if (item.type === "spacer") {
          writeSpacer(false);
          continue;
        }
        if (!item.text) continue;
        if (hasSpacer) {
          logBox.log(item.text);
          lastLogWasSpacer = false;
          hasLoggedAny = true;
        } else {
          recordLog(item.type || "unknown", item.text, item.meta || {}, false);
        }
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return;
      }
      if (err && typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`chat history load failed (${historyFile}): ${err.message || err}`);
      }
    }
  }

  function setHistoryTarget(next = {}) {
    if (!next.historyDir || !next.historyFile) {
      throw new Error("setHistoryTarget requires historyDir/historyFile");
    }
    historyDir = next.historyDir;
    historyFile = next.historyFile;
  }

  function resetViewState() {
    // Callers are expected to clear logBox separately; this only resets spacing trackers.
    lastLogWasSpacer = false;
    hasLoggedAny = false;
  }

  return {
    appendHistory,
    writeSpacer,
    recordLog,
    logMessage,
    markStreamStart,
    loadHistory,
    setHistoryTarget,
    resetViewState,
  };
}

module.exports = {
  createChatLogController,
};
