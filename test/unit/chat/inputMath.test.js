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
  const cjkStrWidth = (s) => Array.from(String(s || "")).reduce((total, ch) => {
    return total + (/[\u3400-\u9fff]/.test(ch) ? 2 : 1);
  }, 0);

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

  test("getCursorRowCol does not add a phantom row at an exact wrap boundary", () => {
    expect(getCursorRowCol("abcd", 2, 2, strWidth)).toEqual({ row: 0, col: 2 });
    expect(getCursorRowCol("abcd", 4, 2, strWidth)).toEqual({ row: 1, col: 2 });
  });

  test("CJK cursor math handles exact-width lines before explicit newlines", () => {
    const text = "你好你\n世界";
    expect(countLines(text, 6, cjkStrWidth)).toBe(2);
    expect(getCursorRowCol(text, 3, 6, cjkStrWidth)).toEqual({ row: 0, col: 6 });
    expect(getCursorRowCol(text, 4, 6, cjkStrWidth)).toEqual({ row: 1, col: 0 });
    expect(getCursorRowCol(text, 6, 6, cjkStrWidth)).toEqual({ row: 1, col: 4 });
  });

  test("CJK cursor math wraps before a wide char that cannot fit", () => {
    const text = "你好你\n世界";
    expect(countLines(text, 5, cjkStrWidth)).toBe(3);
    expect(getCursorRowCol(text, 2, 5, cjkStrWidth)).toEqual({ row: 0, col: 4 });
    expect(getCursorRowCol(text, 3, 5, cjkStrWidth)).toEqual({ row: 1, col: 2 });
    expect(getCursorRowCol(text, 4, 5, cjkStrWidth)).toEqual({ row: 2, col: 0 });
  });

  test("getCursorPosForRowCol maps row/col back to offset", () => {
    const text = "abcd\nef";
    // width=2, rows: "ab"(0),"cd"(1),"ef"(2)
    const pos = getCursorPosForRowCol(text, 1, 1, 2, strWidth);
    // row1 col1 in first line wrap points to index 3 ("d")
    expect(pos).toBe(3);
  });

  test("getCursorPosForRowCol maps CJK rows around explicit newlines", () => {
    const text = "你好你\n世界";
    expect(getCursorPosForRowCol(text, 0, 6, 6, cjkStrWidth)).toBe(3);
    expect(getCursorPosForRowCol(text, 1, 0, 6, cjkStrWidth)).toBe(4);
    expect(getCursorPosForRowCol(text, 1, 4, 6, cjkStrWidth)).toBe(6);
  });

  test("normalizePaste strips bracketed paste markers and CR variants", () => {
    const raw = "\u001b[200~a\r\nb\rc\u001b[201~";
    expect(normalizePaste(raw)).toBe("a\nb\nc");
  });
});
