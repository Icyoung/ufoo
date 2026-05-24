"use strict";

const { layoutRows, createMultilineInput } = require("../../../src/ui/ink/MultilineInput");

describe("layoutRows", () => {
  test("empty value renders one row with cursor at offset 0", () => {
    const rows = layoutRows("", 10, 0);
    expect(rows.length).toBe(1);
    expect(rows[0].segments).toEqual([{ text: " ", cursor: true }]);
  });

  test("ascii line, cursor in the middle", () => {
    const rows = layoutRows("hello", 80, 2);
    expect(rows.length).toBe(1);
    const cursorSeg = rows[0].segments.find((s) => s.cursor);
    expect(cursorSeg.text).toBe("l"); // index 2 of 'hello'
  });

  test("wraps long ascii at width", () => {
    const rows = layoutRows("abcdefghij", 4, 0);
    expect(rows.length).toBe(3); // ceil(10/4)
    expect(rows[0].segments.filter((s) => s.text !== " ").length).toBeLessThanOrEqual(4);
  });

  test("explicit newline starts a new row", () => {
    const rows = layoutRows("ab\ncd", 80, 4); // cursor on 'd'
    expect(rows.length).toBe(2);
    const second = rows[1];
    const cursorSeg = second.segments.find((s) => s.cursor);
    expect(cursorSeg.text).toBe("d");
  });

  test("cursor at very end shows trailing inverted space", () => {
    const rows = layoutRows("hi", 80, 2);
    const last = rows[rows.length - 1];
    expect(last.segments[last.segments.length - 1]).toEqual({
      text: " ",
      cursor: true,
    });
  });

  test("CJK glyph occupies two cells when wrapping", () => {
    // width 3 should fit 一 (2) + a (1); the next char wraps.
    const rows = layoutRows("一ab", 3, 0);
    // First row: 一 (cursor) + a → cellsUsed = 3
    // Second row: b
    expect(rows.length).toBe(2);
    expect(rows[0].cellsUsed).toBe(3);
    expect(rows[1].segments.find((s) => s.text === "b")).toBeTruthy();
  });

  test("does not double-count the cursor when it sits on a newline", () => {
    const rows = layoutRows("a\nb", 80, 1); // cursor on the '\n'
    // Newline should be replaced by an inverted space at the end of row 0,
    // not as a real char on row 1.
    expect(rows.length).toBe(2);
    const firstRowCursors = rows[0].segments.filter((s) => s.cursor).length;
    expect(firstRowCursors).toBe(1);
    const secondRowCursors = rows[1].segments.filter((s) => s.cursor).length;
    expect(secondRowCursors).toBe(0);
  });

  test("cursor < 0 suppresses the cursor entirely (placeholder mode)", () => {
    const rows = layoutRows("", 10, -1);
    expect(rows.length).toBe(1);
    expect(rows[0].segments).toEqual([]);

    const rows2 = layoutRows("hello", 10, -1);
    const allCursorSegs = rows2.flatMap((r) => r.segments).filter((s) => s.cursor);
    expect(allCursorSegs).toEqual([]);
  });
});

describe("createMultilineInput factory", () => {
  test("returns a render function with a small parameter footprint", () => {
    const React = require("react");
    const ink = {
      Box: () => null,
      Text: () => null,
      useInput: () => undefined,
    };
    const Component = createMultilineInput({ React, ink });
    expect(typeof Component).toBe("function");
  });
});
