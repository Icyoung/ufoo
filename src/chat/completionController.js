const FALLBACK_LAUNCH_SUBCOMMANDS = [
  { cmd: "claude", desc: "Launch Claude agent" },
  { cmd: "codex", desc: "Launch Codex agent" },
  { cmd: "ucode", desc: "Launch ucode core agent" },
];

function createCompletionController(options = {}) {
  const {
    input,
    screen,
    completionPanel,
    promptBox,
    commandRegistry = [],
    getGroupTemplateCandidates = () => [],
    getMentionCandidates = () => [],
    normalizeCommandPrefix = () => {},
    truncateText = (text) => String(text || ""),
    getCurrentInputHeight = () => 4,
    getCursorPos = () => 0,
    setCursorPos = () => {},
    resetPreferredCol = () => {},
    updateDraftFromInput = () => {},
    renderScreen = () => {},
    setImmediateFn = setImmediate,
    clearImmediateFn = clearImmediate,
  } = options;

  if (!input || !screen || !completionPanel || !promptBox) {
    throw new Error("createCompletionController requires input/screen/completionPanel/promptBox");
  }

  const state = {
    active: false,
    commands: [],
    index: 0,
    scrollOffset: 0,
    visibleCount: 0,
    enterSuppressed: false,
    enterReset: null,
  };

  function setPanelLayout() {
    const availableHeight = Math.max(1, screen.height - getCurrentInputHeight() - 1);
    const maxVisible = Math.max(1, availableHeight - 2);
    state.visibleCount = Math.min(7, state.commands.length, maxVisible);
    completionPanel.height = Math.min(availableHeight, state.visibleCount + 2);
    completionPanel.bottom = getCurrentInputHeight() - 1;
  }

  function render() {
    if (!state.active || state.commands.length === 0) return;

    const panelVisible = Math.max(1, (completionPanel.height || 1) - 2);
    const maxVisible = state.visibleCount
      ? Math.max(1, Math.min(state.visibleCount, panelVisible))
      : panelVisible;

    if (state.index < state.scrollOffset) {
      state.scrollOffset = state.index;
    } else if (state.index >= state.scrollOffset + maxVisible) {
      state.scrollOffset = state.index - maxVisible + 1;
    }

    const visibleStart = state.scrollOffset;
    const visibleEnd = Math.min(state.scrollOffset + maxVisible, state.commands.length);
    const visibleCommands = state.commands.slice(visibleStart, visibleEnd);

    const panelWidth = typeof completionPanel.width === "number"
      ? completionPanel.width
      : screen.width;

    const lines = visibleCommands.map((item, i) => {
      const actualIndex = visibleStart + i;
      const cmdText = item.cmd;
      const descText = item.desc || "";
      const cmdPart = actualIndex === state.index
        ? `{inverse}${cmdText}{/inverse}`
        : `{cyan-fg}${cmdText}{/cyan-fg}`;
      const indent = " ".repeat(promptBox.width || 2);
      const maxDescWidth = Math.max(0, panelWidth - indent.length - cmdText.length - 2);
      const trimmedDesc = truncateText(descText, maxDescWidth);
      const descPart = trimmedDesc ? `{gray-fg}${trimmedDesc}{/gray-fg}` : "";
      return descPart ? `${indent}${cmdPart}  ${descPart}` : `${indent}${cmdPart}`;
    });

    completionPanel.setContent(lines.join("\n"));
    renderScreen();
  }

  function hide() {
    state.active = false;
    state.commands = [];
    state.index = 0;
    state.scrollOffset = 0;
    state.visibleCount = 0;
    completionPanel.hidden = true;
    renderScreen();
  }

  function buildCommands(filterText) {
    const mentionMatch = String(filterText || "").match(/^@([^\s]*)$/);
    if (mentionMatch) {
      const mentionFilter = String(mentionMatch[1] || "").trim().toLowerCase();
      const rawCandidates = Array.isArray(getMentionCandidates()) ? getMentionCandidates() : [];
      const seen = new Set();
      const items = [];
      for (const item of rawCandidates) {
        const id = String(item && item.id ? item.id : "").trim();
        const label = String(item && item.label ? item.label : id).trim();
        if (!id && !label) continue;
        const rawToken = label || id;
        const normalizedToken = rawToken.replace(/^@+/, "");
        if (!normalizedToken || /\s/.test(normalizedToken)) continue;
        const tokenLower = normalizedToken.toLowerCase();
        const idLower = id.toLowerCase();
        if (
          mentionFilter
          && !tokenLower.startsWith(mentionFilter)
          && !idLower.startsWith(mentionFilter)
        ) {
          continue;
        }
        if (seen.has(normalizedToken)) continue;
        seen.add(normalizedToken);
        const desc = id && id !== normalizedToken ? id : "";
        items.push({
          cmd: `@${normalizedToken}`,
          desc,
          isMention: true,
          mentionTarget: normalizedToken,
        });
      }
      return items.sort((a, b) => a.cmd.localeCompare(b.cmd));
    }

    const endsWithSpace = /\s$/.test(filterText);
    const trimmed = filterText.trim();
    if (!trimmed) {
      return [];
    }

    const parts = trimmed.split(/\s+/);
    const mainCmd = parts[0];
    const isLaunch = mainCmd && mainCmd.toLowerCase() === "/launch";
    const isGroup = mainCmd && mainCmd.toLowerCase() === "/group";
    const wantsSubcommands = (parts.length > 1 || (endsWithSpace && parts.length === 1));

    if (isGroup) {
      const groupSubcommand = String(parts[1] || "").trim().toLowerCase();
      const wantsGroupRunArgs = groupSubcommand === "run" && (parts.length > 2 || endsWithSpace);
      if (wantsGroupRunArgs) {
        const aliasFilter = String(parts[2] || "").trim().toLowerCase();
        return (Array.isArray(getGroupTemplateCandidates()) ? getGroupTemplateCandidates() : [])
          .map((item) => {
            const alias = String(item && item.alias ? item.alias : item && item.cmd ? item.cmd : "").trim();
            if (!alias) return null;
            const desc = String(item && item.desc ? item.desc : item && item.name ? item.name : "").trim();
            const source = String(item && item.source ? item.source : "").trim();
            const detail = [desc, source].filter(Boolean).join(" · ");
            return {
              cmd: alias,
              desc: detail,
              isArgumentSuggestion: true,
              argumentPrefix: "/group run",
            };
          })
          .filter((item) => item && (!aliasFilter || item.cmd.toLowerCase().startsWith(aliasFilter)))
          .sort((a, b) => a.cmd.localeCompare(b.cmd, "en", { sensitivity: "base" }));
      }
    }

    if ((wantsSubcommands || isLaunch) && mainCmd && mainCmd.startsWith("/")) {
      const subFilter = parts[1] || "";
      const mainCmdObj = commandRegistry.find((item) =>
        item.cmd.toLowerCase() === mainCmd.toLowerCase()
      );
      if ((mainCmdObj && mainCmdObj.subcommands) || isLaunch) {
        const baseSubs = mainCmdObj && mainCmdObj.subcommands ? mainCmdObj.subcommands : [];
        let subs = baseSubs;
        if (isLaunch) {
          const merged = new Map();
          for (const sub of [...baseSubs, ...FALLBACK_LAUNCH_SUBCOMMANDS]) {
            if (!sub || !sub.cmd) continue;
            merged.set(sub.cmd, sub);
          }
          subs = Array.from(merged.values());
        }
        if (isLaunch) {
          return subs
            .map((sub) => ({ ...sub, isSubcommand: true, parentCmd: mainCmd }))
            .sort((a, b) => a.cmd.localeCompare(b.cmd));
        }
        return subs
          .filter((sub) => sub.cmd.toLowerCase().startsWith(subFilter.toLowerCase()))
          .map((sub) => ({ ...sub, isSubcommand: true, parentCmd: mainCmd }))
          .sort((a, b) => a.cmd.localeCompare(b.cmd));
      }
      return [];
    }

    const filterLower = trimmed.toLowerCase();
    return commandRegistry.filter((item) => item.cmd.toLowerCase().startsWith(filterLower));
  }

  function show(filterText) {
    normalizeCommandPrefix();

    let nextFilter = filterText;
    if (nextFilter !== input.value) {
      nextFilter = input.value;
    }

    if (nextFilter.startsWith("//")) {
      nextFilter = nextFilter.replace(/^\/+/, "/");
      input.value = nextFilter;
      setCursorPos(Math.min(getCursorPos(), input.value.length));
    }

    if (!nextFilter) {
      hide();
      return;
    }

    const commands = buildCommands(nextFilter);
    if (commands.length === 0) {
      hide();
      return;
    }

    state.commands = commands;
    state.active = true;
    state.index = 0;
    state.scrollOffset = 0;
    setPanelLayout();
    completionPanel.hidden = false;
    render();
  }

  function pageSize() {
    const panelVisible = Math.max(1, (completionPanel.height || 2) - 2);
    return state.visibleCount
      ? Math.max(1, Math.min(state.visibleCount, panelVisible))
      : panelVisible;
  }

  function up() {
    if (state.commands.length === 0) return;
    state.index = state.index <= 0 ? state.commands.length - 1 : state.index - 1;
    render();
  }

  function down() {
    if (state.commands.length === 0) return;
    state.index = state.index >= state.commands.length - 1 ? 0 : state.index + 1;
    render();
  }

  function pageUp() {
    if (state.commands.length === 0) return;
    state.index = Math.max(0, state.index - pageSize());
    render();
  }

  function pageDown() {
    if (state.commands.length === 0) return;
    state.index = Math.min(state.commands.length - 1, state.index + pageSize());
    render();
  }

  function preview(selected) {
    const current = input.value || "";
    const trimmed = current.trim();
    const endsWithSpace = /\s$/.test(current);

    if (selected.isMention) {
      const mentionTarget = String(selected.mentionTarget || selected.cmd || "").replace(/^@+/, "");
      const completedCore = `@${mentionTarget}`;
      const isComplete = (trimmed === completedCore && endsWithSpace) || trimmed.startsWith(`${completedCore} `);
      return { text: `${completedCore} `, isComplete };
    }

    if (selected.isSubcommand) {
      const parts = trimmed.split(/\s+/);
      const base = parts[0] || "";
      const completedCore = base ? `${base} ${selected.cmd}` : selected.cmd;
      const isComplete = trimmed === completedCore || trimmed.startsWith(`${completedCore} `);
      return { text: `${completedCore} `, isComplete };
    }

    if (selected.isArgumentSuggestion) {
      const prefix = String(selected.argumentPrefix || "").trim();
      const completedCore = prefix ? `${prefix} ${selected.cmd}` : selected.cmd;
      const isComplete = trimmed === completedCore || trimmed.startsWith(`${completedCore} `);
      return { text: `${completedCore} `, isComplete };
    }

    const completedCore = selected.cmd;
    const hasChildren = selected.subcommands && selected.subcommands.length > 0;
    const isComplete =
      (trimmed === completedCore && (!hasChildren || endsWithSpace)) ||
      trimmed.startsWith(`${completedCore} `);
    return { text: `${completedCore} `, isComplete };
  }

  function applyPreview(nextPreview) {
    input.value = nextPreview.text;
    setCursorPos(input.value.length);
    resetPreferredCol();
    if (typeof input._updateCursor === "function") {
      input._updateCursor();
    }
    updateDraftFromInput();
    renderScreen();
  }

  function confirm() {
    if (!state.active || state.commands.length === 0) return;

    const selected = state.commands[state.index];
    if (selected.isMention) {
      const mentionTarget = String(selected.mentionTarget || selected.cmd || "").replace(/^@+/, "");
      input.value = `@${mentionTarget} `;
    } else if (selected.isSubcommand) {
      const parts = input.value.split(/\s+/);
      parts[parts.length - 1] = selected.cmd;
      input.value = `${parts.join(" ")} `;
    } else if (selected.isArgumentSuggestion) {
      const prefix = String(selected.argumentPrefix || "").trim();
      input.value = prefix ? `${prefix} ${selected.cmd} ` : `${selected.cmd} `;
    } else {
      input.value = `${selected.cmd} `;
    }

    setCursorPos(input.value.length);
    resetPreferredCol();
    if (typeof input._updateCursor === "function") {
      input._updateCursor();
    }
    updateDraftFromInput();

    if (!selected.isSubcommand && selected.subcommands && selected.subcommands.length > 0) {
      show(input.value);
    } else if (selected.isSubcommand && selected.parentCmd === "/group" && selected.cmd === "run") {
      show(input.value);
    } else {
      hide();
    }

    renderScreen();
  }

  function handleKey(ch, key = {}) {
    if (!state.active) return false;

    if (key.name === "up") {
      up();
      return true;
    }
    if (key.name === "down") {
      down();
      return true;
    }
    if (key.name === "tab") {
      confirm();
      return true;
    }
    if (key.name === "pageup") {
      pageUp();
      return true;
    }
    if (key.name === "pagedown") {
      pageDown();
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      if (state.enterSuppressed) {
        return true;
      }
      const selected = state.commands[state.index];
      if (selected) {
        const nextPreview = preview(selected);
        if (!nextPreview.isComplete) {
          applyPreview(nextPreview);
          if (!selected.isSubcommand && selected.subcommands && selected.subcommands.length > 0) {
            show(input.value);
          } else if (selected.isSubcommand && selected.parentCmd === "/group" && selected.cmd === "run") {
            show(input.value);
          } else {
            hide();
          }
          state.enterSuppressed = true;
          if (state.enterReset) clearImmediateFn(state.enterReset);
          state.enterReset = setImmediateFn(() => {
            state.enterSuppressed = false;
          });
          return true;
        }
      }
      hide();
      state.enterSuppressed = true;
      if (state.enterReset) clearImmediateFn(state.enterReset);
      state.enterReset = setImmediateFn(() => {
        state.enterSuppressed = false;
      });
      return false;
    }

    if (key.name === "escape") {
      hide();
      return true;
    }

    if (ch === " ") {
      const currentInput = (input.value || "").trim();
      if (currentInput.startsWith("/") && !currentInput.includes(" ")) {
        return false;
      }
      if (currentInput.startsWith("@") && !currentInput.includes(" ")) {
        return false;
      }
      hide();
      return false;
    }

    return false;
  }

  function reflow() {
    if (!state.active) return;
    setPanelLayout();
    render();
  }

  function jumpToLast() {
    if (state.commands.length === 0) return;
    state.index = state.commands.length - 1;
    render();
  }

  return {
    show,
    hide,
    handleKey,
    reflow,
    isActive: () => state.active,
    getCommandCount: () => state.commands.length,
    jumpToLast,
  };
}

module.exports = {
  createCompletionController,
};
