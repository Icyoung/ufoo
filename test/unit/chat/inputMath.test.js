const {
  getInnerWidth,
  getWrapWidth,
  countLines,
  getCursorRowCol,
  getCursorPosForRowCol,
  normalizePaste,
} = require("../../../src/chat/inputMath");

describe("chat inputMath helpers", () => {
  const strWidth = (s) => Array.from(String(s || "")).length;

  test("getInnerWidth prefers lpos coordinates", () => {
    const input = {
      lpos: { xl: 21, xi: 10 },
      _getCoords: jest.fn(),
    };
    const screen = { width: 100 };
    expect(getInnerWidth({ input, screen, promptWidth: 2 })).toBe(11);
  });

  test("getInnerWidth falls back to numeric input width", () => {
    const input = {
      lpos: null,
      _getCoords: () => null,
      width: 33,
    };
    const screen = { width: 100 };
    expect(getInnerWidth({ input, screen, promptWidth: 2 })).toBe(33);
  });

  test("getInnerWidth resolves 100%-N width string", () => {
    const input = {
      lpos: null,
      _getCoords: () => null,
      width: "100%-4",
    };
    const screen = { width: 80 };
    expect(getInnerWidth({ input, screen, promptWidth: 2 })).toBe(76);
  });

  test("getInnerWidth falls back to screen width minus prompt", () => {
    const input = {
      lpos: null,
      _getCoords: () => null,
      width: "abc",
    };
    const screen = { width: 50 };
    expect(getInnerWidth({ input, screen, promptWidth: 3 })).toBe(47);
  });

  test("getWrapWidth uses clines width when available", () => {
    const input = { _clines: { width: 17 } };
    expect(getWrapWidth(input, 10)).toBe(17);
    expect(getWrapWidth({}, 10)).toBe(10);
  });

  test("countLines accounts for wrapping and newlines", () => {
    expect(countLines("abcd", 2, strWidth)).toBe(2);
    expect(countLines("ab\ncdef", 2, strWidth)).toBe(3);
  });

  test("getCursorRowCol computes wrapped row/col", () => {
    const text = "abcd\nef";
    // before pos 5 => "abcd\n" => row 2, col 0 when width=2
    expect(getCursorRowCol(text, 5, 2, strWidth)).toEqual({ row: 2, col: 0 });
  });

  test("getCursorPosForRowCol maps row/col back to offset", () => {
    const text = "abcd\nef";
    // width=2, rows: "ab"(0),"cd"(1),"ef"(2)
    const pos = getCursorPosForRowCol(text, 1, 1, 2, strWidth);
    // row1 col1 in first line wrap points to index 3 ("d")
    expect(pos).toBe(3);
  });

  test("normalizePaste strips bracketed paste markers and CR variants", () => {
    const raw = "\u001b[200~a\r\nb\rc\u001b[201~";
    expect(normalizePaste(raw)).toBe("a\nb\nc");
  });
});
