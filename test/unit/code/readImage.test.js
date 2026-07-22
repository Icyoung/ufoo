"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  runReadImageTool,
  MAX_IMAGE_BYTES,
} = require("../../../src/code/tools/readImage");
const { persistToolResultToContext } = require("../../../src/code/context/assembler");
const { stripVisionBase64 } = require("../../../src/code/providers/visionBlocks");

// 1x1 PNG
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("read_image tool", () => {
  test("reads a png and returns base64 + mediaType", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-read-image-"));
    const rel = "shot.png";
    fs.writeFileSync(path.join(root, rel), PNG_1X1);
    const result = runReadImageTool({ path: rel }, { workspaceRoot: root });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("image");
    expect(result.mediaType).toBe("image/png");
    expect(result.bytes).toBe(PNG_1X1.length);
    expect(result.base64).toBe(PNG_1X1.toString("base64"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects unsupported text files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-read-image-txt-"));
    fs.writeFileSync(path.join(root, "note.txt"), "hello");
    const result = runReadImageTool({ path: "note.txt" }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported image type/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects oversized images", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-read-image-big-"));
    const filePath = path.join(root, "huge.png");
    fs.writeFileSync(filePath, Buffer.alloc(MAX_IMAGE_BYTES + 10, 1));
    // Overwrite header so sniff would work if size check passed
    const fd = fs.openSync(filePath, "r+");
    fs.writeSync(fd, PNG_1X1, 0, Math.min(PNG_1X1.length, 16), 0);
    fs.closeSync(fd);
    const result = runReadImageTool({ path: "huge.png" }, { workspaceRoot: root });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("persist strips base64 from artifact but keeps it in modelPayload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-read-image-persist-"));
    fs.writeFileSync(path.join(root, "a.png"), PNG_1X1);
    const raw = runReadImageTool({ path: "a.png" }, { workspaceRoot: root });
    expect(raw.base64).toBeTruthy();
    const persisted = persistToolResultToContext({
      workspaceRoot: root,
      sessionId: "sess-vision-1",
      tool: "read_image",
      args: { path: "a.png" },
      rawResult: raw,
    });
    expect(persisted.modelPayload.base64).toBe(raw.base64);
    expect(persisted.modelPayload.kind).toBe("image");
    expect(persisted.artifact.raw.base64).toBeUndefined();
    expect(stripVisionBase64(raw).base64).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
