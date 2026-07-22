"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  extractImagePathsFromPaste,
  stripExtractedPathsFromText,
  ingestImageFile,
  handleImagePaste,
  formatImageLogLabel,
  formatUserLogWithAttachments,
  buildAttachedImagesPromptPrefix,
  tryIngestClipboardImage,
} = require("../../../src/code/imageIngest");
const { redactUserMessageForLog, normalizeToolLogDetail, toolMessagePreview } = require("../../../src/ui/format");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("imageIngest", () => {
  test("extractImagePathsFromPaste finds quoted, file://, and bare paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-img-paths-"));
    const shot = path.join(dir, "shot.png");
    fs.writeFileSync(shot, PNG_1X1);
    const text = [
      `please check "${shot}"`,
      `file://${shot}`,
      shot,
    ].join("\n");
    const paths = extractImagePathsFromPaste(text);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths.some((p) => path.resolve(p) === path.resolve(shot))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("ingestImageFile copies into workspace uploads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-img-ws-"));
    const src = path.join(os.tmpdir(), `src-${Date.now()}.png`);
    fs.writeFileSync(src, PNG_1X1);
    const result = ingestImageFile({
      sourcePath: src,
      workspaceRoot: root,
      sessionId: "sess-1",
    });
    expect(result.ok).toBe(true);
    expect(result.relPath).toMatch(/^\.ufoo\/agent\/ucode\/uploads\/sess-1\//);
    expect(fs.existsSync(result.absPath)).toBe(true);
    expect(result.mediaType).toBe("image/png");
    expect(result.base64).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(src); } catch { /* ignore */ }
  });

  test("handleImagePaste strips paths and returns attachments", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-img-paste-"));
    const src = path.join(root, "ui.png");
    fs.writeFileSync(src, PNG_1X1);
    const outcome = handleImagePaste(`${src} medium broken`, {
      workspaceRoot: root,
      sessionId: "sess-2",
      tryClipboard: false,
    });
    expect(outcome.attachments).toHaveLength(1);
    expect(outcome.text).toMatch(/medium broken/);
    expect(outcome.text).not.toContain(src);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("tryIngestClipboardImage uses osascript result on darwin", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-img-clip-"));
    const result = tryIngestClipboardImage({
      workspaceRoot: root,
      sessionId: "sess-clip",
      platform: "darwin",
      execFile: (cmd, args) => {
        expect(cmd).toBe("osascript");
        const script = args[1] || "";
        const match = script.match(/POSIX file "([^"]+)"/);
        expect(match).toBeTruthy();
        fs.writeFileSync(match[1], PNG_1X1);
        return "ok\n";
      },
    });
    expect(result.ok).toBe(true);
    expect(result.relPath).toContain("uploads/sess-clip/");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("log helpers never expose base64", () => {
    expect(formatImageLogLabel({ fileName: "shot.png" })).toBe("[image: shot.png]");
    expect(formatUserLogWithAttachments("hello", [{ fileName: "a.png" }]))
      .toBe("[image: a.png] hello");
    const prefix = buildAttachedImagesPromptPrefix([
      { relPath: ".ufoo/agent/ucode/uploads/s/x.png" },
    ]);
    expect(prefix).toContain("read_image");
    expect(prefix).toContain(".ufoo/agent/ucode/uploads/s/x.png");

    const redacted = redactUserMessageForLog(
      `${prefix}look at this\ndata:image/png;base64,AAAA\n{"base64":"BBBB"}`,
    );
    expect(redacted).toContain("[image: x.png]");
    expect(redacted).not.toContain("AAAA");
    expect(redacted).not.toContain("BBBB");
    expect(redacted).not.toMatch(/data:image/);

    expect(normalizeToolLogDetail("read_image", { path: "uploads/x.png" }, {}))
      .toBe("[image: x.png]");
    expect(toolMessagePreview({
      role: "tool",
      content: JSON.stringify({
        ok: true,
        kind: "image",
        path: "/tmp/a.png",
        base64: "CCCC",
        preview: "image /tmp/a.png",
      }),
    })).not.toContain("CCCC");
  });

  test("stripExtractedPathsFromText removes quoted paths", () => {
    const p = "/tmp/foo bar.png";
    expect(stripExtractedPathsFromText(`see "${p}" please`, [p])).toBe("see please");
  });
});
