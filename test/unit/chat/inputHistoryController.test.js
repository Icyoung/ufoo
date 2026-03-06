const { createInputHistoryController } = require("../../../src/chat/inputHistoryController");

describe("chat inputHistoryController", () => {
  test("requires file path and dir", () => {
    expect(() => createInputHistoryController({})).toThrow(
      /requires inputHistoryFile and historyDir/
    );
  });

  test("loadInputHistory reads and filters entries", () => {
    const setInputValue = jest.fn();
    let currentValue = "";
    const fsMod = {
      readFileSync: jest.fn(() =>
        `${JSON.stringify({ text: "one" })}\n` +
        `${JSON.stringify({ text: "   " })}\n` +
        `${JSON.stringify({ text: "two" })}\n`
      ),
      mkdirSync: jest.fn(),
      appendFileSync: jest.fn(),
    };

    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history.jsonl",
      historyDir: "/tmp",
      setInputValue,
      getInputValue: () => currentValue,
      fsMod,
    });

    controller.loadInputHistory();
    const state = controller.getState();

    expect(state.history).toEqual(["one", "two"]);
    expect(state.historyIndex).toBe(2);
  });

  test("historyUp/historyDown preserve draft and navigate", () => {
    let currentValue = "draft";
    const setInputValue = jest.fn((value) => {
      currentValue = value;
    });
    const fsMod = {
      readFileSync: jest.fn(() =>
        `${JSON.stringify({ text: "one" })}\n${JSON.stringify({ text: "two" })}\n`
      ),
      mkdirSync: jest.fn(),
      appendFileSync: jest.fn(),
    };

    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history.jsonl",
      historyDir: "/tmp",
      setInputValue,
      getInputValue: () => currentValue,
      fsMod,
    });

    controller.loadInputHistory();

    expect(controller.historyUp()).toBe(true);
    expect(setInputValue).toHaveBeenLastCalledWith("two");

    expect(controller.historyUp()).toBe(true);
    expect(setInputValue).toHaveBeenLastCalledWith("one");

    expect(controller.historyDown()).toBe(true);
    expect(setInputValue).toHaveBeenLastCalledWith("two");

    expect(controller.historyDown()).toBe(true);
    expect(setInputValue).toHaveBeenLastCalledWith("draft");

    expect(controller.historyDown()).toBe(false);
  });

  test("commitSubmittedText appends to history and file", () => {
    const fsMod = {
      readFileSync: jest.fn(() => ""),
      mkdirSync: jest.fn(),
      appendFileSync: jest.fn(),
    };

    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history.jsonl",
      historyDir: "/tmp",
      setInputValue: jest.fn(),
      getInputValue: jest.fn(() => ""),
      fsMod,
    });

    controller.commitSubmittedText("hello");

    const state = controller.getState();
    expect(state.history).toEqual(["hello"]);
    expect(state.historyIndex).toBe(1);
    expect(state.historyDraft).toBe("");
    expect(fsMod.mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(fsMod.appendFileSync).toHaveBeenCalledWith(
      "/tmp/history.jsonl",
      `${JSON.stringify({ text: "hello" })}\n`
    );
  });

  test("setIndexToEnd clears draft", () => {
    let currentValue = "x";
    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history.jsonl",
      historyDir: "/tmp",
      setInputValue: jest.fn((value) => {
        currentValue = value;
      }),
      getInputValue: () => currentValue,
      fsMod: {
        readFileSync: jest.fn(() => `${JSON.stringify({ text: "one" })}\n`),
        mkdirSync: jest.fn(),
        appendFileSync: jest.fn(),
      },
    });

    controller.loadInputHistory();
    controller.historyUp();
    controller.setIndexToEnd();

    const state = controller.getState();
    expect(state.historyIndex).toBe(state.history.length);
    expect(state.historyDraft).toBe("");
  });

  test("loadInputHistory replaces prior in-memory entries", () => {
    const fsMod = {
      readFileSync: jest
        .fn()
        .mockReturnValueOnce(`${JSON.stringify({ text: "one" })}\n`)
        .mockReturnValueOnce(`${JSON.stringify({ text: "two" })}\n`),
      mkdirSync: jest.fn(),
      appendFileSync: jest.fn(),
    };

    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history-a.jsonl",
      historyDir: "/tmp",
      setInputValue: jest.fn(),
      getInputValue: jest.fn(() => ""),
      fsMod,
    });

    controller.loadInputHistory();
    controller.loadInputHistory();

    expect(controller.getState().history).toEqual(["two"]);
  });

  test("setHistoryTarget and restoreDraft switch context state", () => {
    let currentValue = "";
    const setInputValue = jest.fn((value) => {
      currentValue = value;
    });
    const fsMod = {
      readFileSync: jest
        .fn()
        .mockImplementation((filePath) => {
          if (filePath === "/tmp/history-a.jsonl") {
            return `${JSON.stringify({ text: "one" })}\n`;
          }
          if (filePath === "/tmp/history-b.jsonl") {
            return `${JSON.stringify({ text: "two" })}\n`;
          }
          return "";
        }),
      mkdirSync: jest.fn(),
      appendFileSync: jest.fn(),
    };

    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history-a.jsonl",
      historyDir: "/tmp/a",
      setInputValue,
      getInputValue: () => currentValue,
      fsMod,
    });

    controller.loadInputHistory();
    expect(controller.getState().history).toEqual(["one"]);

    controller.setHistoryTarget({
      inputHistoryFile: "/tmp/history-b.jsonl",
      historyDir: "/tmp/b",
    });
    controller.loadInputHistory();
    controller.restoreDraft("draft-b");

    const state = controller.getState();
    expect(state.history).toEqual(["two"]);
    expect(state.historyIndex).toBe(1);
    expect(state.historyDraft).toBe("draft-b");
    expect(setInputValue).toHaveBeenCalledWith("draft-b");
  });

  test("getDraftForPersistence prefers preserved draft while browsing history", () => {
    let currentValue = "draft-a";
    const setInputValue = jest.fn((value) => {
      currentValue = value;
    });
    const controller = createInputHistoryController({
      inputHistoryFile: "/tmp/history.jsonl",
      historyDir: "/tmp",
      setInputValue,
      getInputValue: () => currentValue,
      fsMod: {
        readFileSync: jest.fn(() =>
          `${JSON.stringify({ text: "one" })}\n${JSON.stringify({ text: "two" })}\n`
        ),
        mkdirSync: jest.fn(),
        appendFileSync: jest.fn(),
      },
    });

    controller.loadInputHistory();
    expect(controller.getDraftForPersistence()).toBe("draft-a");

    controller.historyUp();
    expect(currentValue).toBe("two");
    expect(controller.getDraftForPersistence()).toBe("draft-a");

    controller.historyDown();
    expect(controller.getDraftForPersistence()).toBe("draft-a");
  });
});
