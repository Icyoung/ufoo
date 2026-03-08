function createStatusLineController(options = {}) {
  const {
    statusLine,
    bannerText = "",
    renderScreen = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = () => Date.now(),
  } = options;

  if (!statusLine) {
    throw new Error("createStatusLineController requires statusLine");
  }

  const pendingStatusLines = [];
  const busStatusQueue = [];
  let primaryStatusText = bannerText;
  let primaryStatusPending = false;

  const shimmerStart = now();
  let animationTimer = null;
  const STATUS_ANIM_FRAME_MS = 50;
  const SHIMMER_PADDING = 10;
  const SHIMMER_BAND_HALF_WIDTH = 5;
  const SHIMMER_SWEEP_MS = 2000;
  const SPINNER_PERIOD_MS = 600;

  function formatProcessingText(text) {
    if (!text) return text;
    if (text.includes("{")) return text;
    if (!/processing/i.test(text)) return text;
    return text;
  }

  function shimmerText(text, nowMs) {
    if (!text) return "";
    if (text.includes("{")) return text;
    const chars = Array.from(text);
    const period = chars.length + SHIMMER_PADDING * 2;
    const pos = Math.floor(((nowMs - shimmerStart) % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS * period);
    let out = "";
    for (let i = 0; i < chars.length; i += 1) {
      const iPos = i + SHIMMER_PADDING;
      const dist = Math.abs(iPos - pos);
      let intensity = 0;
      if (dist <= SHIMMER_BAND_HALF_WIDTH) {
        const x = Math.PI * (dist / SHIMMER_BAND_HALF_WIDTH);
        intensity = 0.5 * (1 + Math.cos(x));
      }
      const ch = chars[i];
      if (intensity < 0.2) {
        out += `{gray-fg}${ch}{/gray-fg}`;
      } else if (intensity < 0.6) {
        out += ch;
      } else {
        out += `{bold}{white-fg}${ch}{/white-fg}{/bold}`;
      }
    }
    return out;
  }

  function spinnerFrame(nowMs) {
    const on = Math.floor((nowMs - shimmerStart) / SPINNER_PERIOD_MS) % 2 === 0;
    return on ? "{gray-fg}•{/gray-fg}" : "{gray-fg}◦{/gray-fg}";
  }

  function renderPendingStatus(text, nowMs) {
    const spinner = spinnerFrame(nowMs);
    const shimmer = shimmerText(text, nowMs);
    return shimmer ? `${spinner} ${shimmer}` : spinner;
  }

  function renderStatusLine(nowMs = now()) {
    let content = primaryStatusText || "";
    if (primaryStatusPending) {
      content = renderPendingStatus(primaryStatusText, nowMs);
    }
    if (busStatusQueue.length > 0) {
      const extra = busStatusQueue.length > 1
        ? ` {gray-fg}(+${busStatusQueue.length - 1}){/gray-fg}`
        : "";
      const busText = `${busStatusQueue[0].text}${extra}`;
      content = content
        ? `${content} {gray-fg}·{/gray-fg} ${busText}`
        : busText;
    }
    statusLine.setContent(content);
  }

  function updateAnimation() {
    if (primaryStatusPending && !animationTimer) {
      animationTimer = setIntervalFn(() => {
        if (!primaryStatusPending) return;
        renderStatusLine(now());
        renderScreen();
      }, STATUS_ANIM_FRAME_MS);
    } else if (!primaryStatusPending && animationTimer) {
      clearIntervalFn(animationTimer);
      animationTimer = null;
    }
  }

  function setPrimaryStatus(text, options = {}) {
    primaryStatusText = text || "";
    primaryStatusPending = Boolean(options.pending);
    updateAnimation();
    renderStatusLine();
  }

  function normalizePendingItem(text, options = {}) {
    const key = options && typeof options.key === "string"
      ? options.key.trim()
      : "";
    return {
      text: text || "",
      key,
    };
  }

  function headPendingText() {
    if (pendingStatusLines.length === 0) return "";
    const item = pendingStatusLines[0];
    return item && typeof item.text === "string" ? item.text : "";
  }

  function queueStatusLine(text, options = {}) {
    const item = normalizePendingItem(text, options);
    if (item.key) {
      const existingIndex = pendingStatusLines.findIndex((entry) => entry.key === item.key);
      if (existingIndex >= 0) {
        pendingStatusLines[existingIndex] = item;
        if (existingIndex === 0) {
          setPrimaryStatus(item.text, { pending: true });
          renderScreen();
        }
        return;
      }
    }

    pendingStatusLines.push(item);
    if (pendingStatusLines.length === 1) {
      setPrimaryStatus(item.text, { pending: true });
      renderScreen();
    }
  }

  function resolveStatusLine(text, options = {}) {
    const key = options && typeof options.key === "string"
      ? options.key.trim()
      : "";
    let removedHead = false;

    if (pendingStatusLines.length > 0) {
      if (key) {
        const index = pendingStatusLines.findIndex((entry) => entry.key === key);
        if (index >= 0) {
          pendingStatusLines.splice(index, 1);
          removedHead = index === 0;
        }
      } else {
        pendingStatusLines.shift();
        removedHead = true;
      }
    }

    if (pendingStatusLines.length > 0) {
      if (removedHead || !primaryStatusPending) {
        setPrimaryStatus(headPendingText(), { pending: true });
      }
    } else {
      setPrimaryStatus(text || "", { pending: false });
    }
    renderScreen();
  }

  function enqueueBusStatus(item) {
    if (!item || !item.text) return;
    const key = item.key || item.text;
    const formatted = formatProcessingText(item.text);
    const existing = busStatusQueue.find((entry) => entry.key === key);
    if (existing) {
      existing.text = formatted;
    } else {
      busStatusQueue.push({ key, text: formatted });
    }
    renderStatusLine();
  }

  function resolveBusStatus(item) {
    if (!item) return;
    const key = item.key || item.text;
    let index = -1;
    if (key) {
      index = busStatusQueue.findIndex((entry) => entry.key === key);
    }
    if (index === -1 && item.text) {
      index = busStatusQueue.findIndex((entry) => entry.text === item.text);
    }
    if (index === -1) return;
    busStatusQueue.splice(index, 1);
    renderStatusLine();
  }

  function destroy() {
    if (animationTimer) {
      clearIntervalFn(animationTimer);
      animationTimer = null;
    }
  }

  return {
    queueStatusLine,
    resolveStatusLine,
    enqueueBusStatus,
    resolveBusStatus,
    renderStatusLine,
    destroy,
  };
}

module.exports = {
  createStatusLineController,
};
