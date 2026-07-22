"use strict";

const fs = require("fs");
const path = require("path");
const { resolveWorkspacePath } = require("./common");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXT_MEDIA = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

function sniffMediaType(buffer = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return "";
}

function mediaTypeFromPath(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return EXT_MEDIA[ext] || "";
}

function runReadImageTool(input = {}, options = {}) {
  try {
    const filePath = String(input.path || input.file || "").trim();
    if (!filePath) {
      return { ok: false, error: "path is required" };
    }
    const { workspaceRoot, resolved } = resolveWorkspacePath(
      options.workspaceRoot,
      filePath,
      options.cwd,
    );
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, error: `not a file: ${resolved}` };
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `image too large (${stat.size} bytes); max ${MAX_IMAGE_BYTES} bytes — compress or resize first`,
        path: resolved,
        bytes: stat.size,
      };
    }

    const buffer = fs.readFileSync(resolved);
    const sniffed = sniffMediaType(buffer);
    const fromExt = mediaTypeFromPath(resolved);
    const mediaType = sniffed || fromExt;
    if (!mediaType) {
      return {
        ok: false,
        error: "unsupported image type (use png, jpeg, gif, or webp)",
        path: resolved,
        bytes: buffer.length,
      };
    }
    if (fromExt && sniffed && fromExt !== sniffed) {
      return {
        ok: false,
        error: `image type mismatch: extension suggests ${fromExt}, bytes are ${sniffed}`,
        path: resolved,
        bytes: buffer.length,
      };
    }

    return {
      ok: true,
      kind: "image",
      workspaceRoot,
      path: resolved,
      mediaType,
      bytes: buffer.length,
      base64: buffer.toString("base64"),
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "read_image failed",
    };
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  EXT_MEDIA,
  sniffMediaType,
  mediaTypeFromPath,
  runReadImageTool,
};
