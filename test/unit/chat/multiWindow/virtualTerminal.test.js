const { createVirtualTerminal } = require("../../../../src/chat/multiWindow/virtualTerminal");

describe("virtualTerminal", () => {
  test("basic text output", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("hello");
    expect(vt.getLine(0)).toBe("hello     ");
    expect(vt.getCursor()).toEqual({ row: 0, col: 5 });
  });

  test("newline advances row without resetting column", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("abc\ndef");
    expect(vt.getLine(0)).toBe("abc       ");
    expect(vt.getLine(1)).toBe("   def    ");
    expect(vt.getCursor()).toEqual({ row: 1, col: 6 });
  });

  test("carriage return resets column", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("hello\rworld");
    expect(vt.getLine(0)).toBe("world     ");
  });

  test("cursor movement CSI", () => {
    const vt = createVirtualTerminal(10, 5);
    vt.write("\x1b[3;5H*");
    expect(vt.getLine(2)[4]).toBe("*");
    expect(vt.getCursor()).toEqual({ row: 2, col: 5 });
  });

  test("erase line", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("abcdefghij");
    vt.write("\x1b[1;5H");
    vt.write("\x1b[0K");
    expect(vt.getLine(0)).toBe("abcd      ");
  });

  test("erase display", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("line1\r\nline2\r\nline3");
    vt.write("\x1b[2J");
    expect(vt.getLine(0)).toBe("          ");
    expect(vt.getLine(1)).toBe("          ");
    expect(vt.getLine(2)).toBe("          ");
  });

  test("SGR color attributes", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("\x1b[31mred\x1b[0m");
    const screen = vt.getScreen();
    expect(screen.buffer[0][0].attr.fg).toBe(1);
    expect(screen.buffer[0][3].attr.fg).toBe(7);
  });

  test("resize preserves content", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("hello");
    vt.resize(5, 2);
    expect(vt.getLine(0)).toBe("hello");
    expect(vt.getScreen().cols).toBe(5);
    expect(vt.getScreen().rows).toBe(2);
  });

  test("dirty tracking", () => {
    const vt = createVirtualTerminal(10, 3);
    expect(vt.isDirty()).toBe(true);
    vt.clearDirty();
    expect(vt.isDirty()).toBe(false);
    vt.write("x");
    expect(vt.isDirty()).toBe(true);
  });

  test("scroll region", () => {
    const vt = createVirtualTerminal(5, 5);
    vt.write("aaa\r\nbbb\r\nccc\r\nddd\r\neee");
    vt.write("\x1b[2;4r");
    vt.write("\x1b[2;1H");
    vt.write("\x1b[M");
    expect(vt.getLine(0)).toBe("aaa  ");
    expect(vt.getLine(1)).toBe("ccc  ");
    expect(vt.getLine(2)).toBe("ddd  ");
    expect(vt.getLine(3)).toBe("     ");
    expect(vt.getLine(4)).toBe("eee  ");
  });

  test("line wrap", () => {
    const vt = createVirtualTerminal(5, 3);
    vt.write("abcdefgh");
    expect(vt.getLine(0)).toBe("abcde");
    expect(vt.getLine(1)).toBe("fgh  ");
    expect(vt.getCursor()).toEqual({ row: 1, col: 3 });
  });

  test("wide CJK characters advance by display width", () => {
    const vt = createVirtualTerminal(10, 3);
    vt.write("你好");
    expect(vt.getLine(0)).toBe("你好      ");
    expect(vt.getCursor()).toEqual({ row: 0, col: 4 });
    expect(vt.getScreen().buffer[0][1].wideContinuation).toBe(true);
    expect(vt.getScreen().buffer[0][3].wideContinuation).toBe(true);
  });

  test("wide character wraps when it cannot fit at line end", () => {
    const vt = createVirtualTerminal(4, 3);
    vt.write("abc你");
    expect(vt.getLine(0)).toBe("abc ");
    expect(vt.getLine(1)).toBe("你  ");
    expect(vt.getCursor()).toEqual({ row: 1, col: 2 });
  });
});
