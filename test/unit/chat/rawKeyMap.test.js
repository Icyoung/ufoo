const { keyToRaw } = require("../../../src/app/chat/rawKeyMap");

describe("chat rawKeyMap", () => {
  test("returns single character input directly", () => {
    expect(keyToRaw("a", { name: "x" })).toBe("a");
  });

  test("returns null when key info is missing", () => {
    expect(keyToRaw("", null)).toBeNull();
  });

  test("maps control/navigation keys to ANSI", () => {
    expect(keyToRaw("", { name: "enter" })).toBe("\r");
    expect(keyToRaw("", { name: "backspace" })).toBe("\x7f");
    expect(keyToRaw("", { name: "escape" })).toBe("\x1b");
    expect(keyToRaw("", { name: "up" })).toBe("\x1b[A");
    expect(keyToRaw("", { name: "down" })).toBe("\x1b[B");
    expect(keyToRaw("", { name: "right" })).toBe("\x1b[C");
    expect(keyToRaw("", { name: "left" })).toBe("\x1b[D");
    expect(keyToRaw("", { name: "pageup" })).toBe("\x1b[5~");
    expect(keyToRaw("", { name: "pagedown" })).toBe("\x1b[6~");
  });

  test("falls back to provided character for unknown keys", () => {
    expect(keyToRaw("/", { name: "slash" })).toBe("/");
    expect(keyToRaw("", { name: "unknown" })).toBeNull();
  });
});
