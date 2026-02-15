function createChatLayout(options = {}) {
  const {
    blessed,
    currentInputHeight = 4,
    version = "unknown",
  } = options;

  const screen = blessed.screen({
    smartCSR: true,
    title: "ufoo chat",
    fullUnicode: true,
    // Toggle mouse at runtime to balance copy vs scroll
    sendFocus: true,
    mouse: false,
    // Allow Ctrl+C to exit even when input grabs keys
    ignoreLocked: ["C-c"],
  });
  // Prefer normal buffer for reliable terminal selection/copy
  if (screen.program && typeof screen.program.normalBuffer === "function") {
    screen.program.normalBuffer();
    if (screen.program.put && typeof screen.program.put.keypad_local === "function") {
      screen.program.put.keypad_local();
    }
    if (typeof screen.program.clear === "function") {
      screen.program.clear();
      screen.program.cup(0, 0);
    }
  }

  // Log area (no border for cleaner look)
  const logBox = blessed.log({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-5", // Will be adjusted dynamically
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollback: 10000,
    scrollbar: null,
    keys: true,
    vi: true,
    // Mouse handled globally (toggleable) to keep copy working
    mouse: false,
    // Ensure proper wrapping and width calculation
    wrap: true,
  });

  // Status line just above input
  const statusLine = blessed.box({
    parent: screen,
    bottom: currentInputHeight,
    left: 0,
    width: "100%",
    height: 1,
    style: { fg: "gray" },
    tags: true,
    content: "",
  });
  const bannerText = `{bold}UFOO{/bold} · Chat Manager{|}v${version}`;
  statusLine.setContent(bannerText);

  // Command completion panel
  const completionPanel = blessed.box({
    parent: screen,
    bottom: currentInputHeight - 1,
    left: 0,
    width: "100%",
    height: 0,
    hidden: true,
    wrap: false,
    border: {
      type: "line",
      top: true,
      left: false,
      right: false,
      bottom: false,
    },
    style: {
      border: { fg: "yellow" },
      fg: "white",
      // No bg - uses terminal default background
    },
    padding: {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
    tags: true,
  });

  // Dashboard at very bottom
  const dashboard = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    style: { fg: "gray" },
    tags: true,
  });

  // Bottom border line for input area (above dashboard)
  const inputBottomLine = blessed.line({
    parent: screen,
    bottom: 1,
    left: 1,
    width: "100%-2",
    orientation: "horizontal",
    style: { fg: "gray" },
  });

  // Prompt indicator
  const promptBox = blessed.box({
    parent: screen,
    bottom: 2,
    left: 0,
    width: 2,
    height: currentInputHeight - 3,
    content: ">",
    style: { fg: "cyan" },
  });

  // Input area without left/right border
  const input = blessed.textarea({
    parent: screen,
    bottom: 2,
    left: 2,
    width: "100%-2",
    height: currentInputHeight - 3,
    inputOnFocus: true,
    keys: true,
  });
  // Avoid textarea's extra wrap margin (causes a phantom empty column)
  input.type = "box";

  // Top border line for input area (just above input)
  const inputTopLine = blessed.line({
    parent: screen,
    bottom: currentInputHeight - 1, // 4-1=3: above input(2) + inputHeight(1)
    left: 1,
    width: "100%-2",
    orientation: "horizontal",
    style: { fg: "gray" },
  });

  return {
    screen,
    logBox,
    statusLine,
    bannerText,
    completionPanel,
    dashboard,
    inputBottomLine,
    promptBox,
    input,
    inputTopLine,
  };
}

module.exports = {
  createChatLayout,
};
