"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getUfooPaths } = require("../../coordination/state/paths");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_VISION_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const IMAGE_EXT_TO_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

const MIME_TO_EXT = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
});

function sniffImageMediaType(buffer) {
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
  if (IMAGE_EXT_TO_MIME[ext]) return IMAGE_EXT_TO_MIME[ext];
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".json") return "application/json";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".csv") return "text/csv";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  return "application/octet-stream";
}

function sanitizeFileName(rawName = "", fallbackExt = "") {
  const base = path.basename(String(rawName || "").trim() || "attachment");
  const cleaned = base
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "-")
    .slice(0, 96);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `attachment${fallbackExt}`;
  }
  if (fallbackExt && !path.extname(cleaned)) {
    return `${cleaned}${fallbackExt}`;
  }
  return cleaned;
}

function isPathInsideRoot(candidatePath, projectRoot) {
  if (!candidatePath || !projectRoot) return false;
  try {
    const resolvedRoot = fs.realpathSync(projectRoot);
    const resolvedPath = fs.realpathSync(candidatePath);
    const rel = path.relative(resolvedRoot, resolvedPath);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    const rel = path.relative(path.resolve(projectRoot), path.resolve(candidatePath));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }
}

function attachmentsDirForProject(projectRoot) {
  return path.join(getUfooPaths(projectRoot).ufooDir, "attachments");
}

function buildPreviewDataUrl(buffer, mediaType) {
  if (!Buffer.isBuffer(buffer) || !mediaType.startsWith("image/")) return "";
  if (buffer.length > MAX_INLINE_VISION_BYTES) return "";
  return `data:${mediaType};base64,${buffer.toString("base64")}`;
}

/**
 * Stage dropped OS file paths and/or base64 uploads for a project.
 * Workspace-local files keep their real path; external files & uploads are
 * copied into `.ufoo/attachments/` so workspace-scoped tools and workers can
 * access them safely.
 */
function stageAttachments(projectRoot, { paths = [], uploads = [] } = {}) {
  if (!projectRoot) {
    return { ok: false, attachments: [], errors: ["projectRoot is required"] };
  }
  const staged = [];
  const errors = [];
  const dir = attachmentsDirForProject(projectRoot);
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true });

  for (const rawPath of (Array.isArray(paths) ? paths : [])) {
    const inputPath = String(rawPath || "").trim();
    if (!inputPath) continue;
    try {
      const absPath = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(projectRoot, inputPath);
      if (!fs.existsSync(absPath)) {
        errors.push(`File not found: ${path.basename(inputPath)}`);
        continue;
      }
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) {
        errors.push(`Folders cannot be attached directly: ${path.basename(absPath)}`);
        continue;
      }
      const headerBuf = Buffer.alloc(Math.min(32, stat.size));
      if (headerBuf.length > 0) {
        const fd = fs.openSync(absPath, "r");
        try {
          fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
        } finally {
          fs.closeSync(fd);
        }
      }
      const sniffed = sniffImageMediaType(headerBuf);
      const guessed = mediaTypeFromPath(absPath);
      const isImage = Boolean(sniffed || guessed.startsWith("image/"));
      const mediaType = sniffed || guessed;
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (stat.size > limit) {
        errors.push(`${path.basename(absPath)} exceeds ${Math.round(limit / (1024 * 1024))}MB limit`);
        continue;
      }

      const id = `att_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
      let targetPath = absPath;
      if (!isPathInsideRoot(absPath, projectRoot)) {
        ensureDir();
        const safeName = sanitizeFileName(path.basename(absPath), isImage ? (MIME_TO_EXT[mediaType] || "") : "");
        targetPath = path.join(dir, `${id}-${safeName}`);
        fs.copyFileSync(absPath, targetPath);
      }

      let previewDataUrl = "";
      if (isImage && stat.size <= MAX_INLINE_VISION_BYTES) {
        previewDataUrl = buildPreviewDataUrl(fs.readFileSync(targetPath), mediaType);
      }

      staged.push({
        id,
        name: path.basename(absPath),
        path: targetPath,
        kind: isImage ? "image" : "file",
        media_type: mediaType,
        bytes: stat.size,
        ...(previewDataUrl ? { preview_data_url: previewDataUrl } : {}),
      });
    } catch (err) {
      errors.push(err && err.message ? err.message : `Failed to attach ${path.basename(inputPath)}`);
    }
  }

  for (const upload of (Array.isArray(uploads) ? uploads : [])) {
    if (!upload || typeof upload !== "object") continue;
    const rawName = String(upload.name || "").trim();
    const rawB64 = String(upload.data_base64 || upload.dataBase64 || "").trim();
    const declaredMime = String(upload.media_type || upload.mediaType || "").trim().toLowerCase();
    if (!rawB64) continue;
    try {
      const stripped = rawB64.includes(",") && rawB64.startsWith("data:")
        ? rawB64.slice(rawB64.indexOf(",") + 1)
        : rawB64;
      const buffer = Buffer.from(stripped, "base64");
      const sniffed = sniffImageMediaType(buffer);
      const inferredFromName = rawName ? mediaTypeFromPath(rawName) : "";
      const mediaType = sniffed || (declaredMime && declaredMime !== "application/octet-stream" ? declaredMime : inferredFromName) || "application/octet-stream";
      const isImage = Boolean(sniffed || mediaType.startsWith("image/"));
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (buffer.length > limit) {
        errors.push(`${rawName || "Attachment"} exceeds ${Math.round(limit / (1024 * 1024))}MB limit`);
        continue;
      }

      ensureDir();
      const id = `att_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
      const fallbackExt = isImage ? (MIME_TO_EXT[mediaType] || ".png") : "";
      const displayName = sanitizeFileName(rawName || (isImage ? `pasted-image${fallbackExt}` : "attachment.bin"), fallbackExt);
      const targetPath = path.join(dir, `${id}-${displayName}`);
      fs.writeFileSync(targetPath, buffer);

      const previewDataUrl = isImage ? buildPreviewDataUrl(buffer, mediaType) : "";
      staged.push({
        id,
        name: displayName,
        path: targetPath,
        kind: isImage ? "image" : "file",
        media_type: mediaType,
        bytes: buffer.length,
        ...(previewDataUrl ? { preview_data_url: previewDataUrl } : {}),
      });
    } catch (err) {
      errors.push(err && err.message ? err.message : `Failed to stage ${rawName || "attachment"}`);
    }
  }

  return {
    ok: staged.length > 0 || errors.length === 0,
    attachments: staged,
    errors,
  };
}

function normalizeAttachmentList(rawList = []) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      const p = item.trim();
      const mime = mediaTypeFromPath(p);
      out.push({
        id: "",
        name: path.basename(p),
        path: p,
        kind: mime.startsWith("image/") ? "image" : "file",
        media_type: mime,
        bytes: 0,
      });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const p = String(item.path || "").trim();
    if (!p) continue;
    const mime = String(item.media_type || item.mediaType || mediaTypeFromPath(p)).trim().toLowerCase();
    const kind = item.kind === "image" || mime.startsWith("image/") ? "image" : "file";
    out.push({
      id: String(item.id || "").trim(),
      name: String(item.name || path.basename(p)).trim(),
      path: p,
      kind,
      media_type: mime,
      bytes: Number.isFinite(Number(item.bytes)) ? Number(item.bytes) : 0,
    });
  }
  return out;
}

/**
 * Inspect normalized attachments on disk, loading inline vision payloads for
 * supported images and generating a clean textual reference block for models.
 */
function loadAttachmentModelContext(rawAttachments = [], workspaceRoot = "") {
  const list = normalizeAttachmentList(rawAttachments);
  if (list.length === 0) {
    return { attachments: [], visionPayloads: [], imagePaths: [], filePaths: [], promptAppendix: "" };
  }

  const resolvedAttachments = [];
  const visionPayloads = [];
  const imagePaths = [];
  const filePaths = [];

  for (const item of list) {
    const resolvedPath = path.isAbsolute(item.path)
      ? path.resolve(item.path)
      : (workspaceRoot ? path.resolve(workspaceRoot, item.path) : path.resolve(item.path));
    const displayPath = workspaceRoot && isPathInsideRoot(resolvedPath, workspaceRoot)
      ? path.relative(workspaceRoot, resolvedPath)
      : resolvedPath;

    let exists = false;
    let size = item.bytes;
    let mediaType = item.media_type;
    let isImage = item.kind === "image";

    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.isFile()) {
        exists = true;
        size = stat.size;
        if (size <= MAX_INLINE_VISION_BYTES) {
          const buf = fs.readFileSync(resolvedPath);
          const sniffed = sniffImageMediaType(buf);
          if (sniffed) {
            isImage = true;
            mediaType = sniffed;
            visionPayloads.push({
              path: resolvedPath,
              displayPath,
              name: item.name,
              mediaType: sniffed,
              bytes: buf.length,
              base64: buf.toString("base64"),
            });
          }
        }
      }
    } catch {
      // keep path reference even if unreadable right now
    }

    if (exists && isImage) {
      imagePaths.push(resolvedPath);
    } else if (exists) {
      filePaths.push(resolvedPath);
    }

    resolvedAttachments.push({
      ...item,
      path: resolvedPath,
      displayPath,
      kind: isImage ? "image" : "file",
      media_type: mediaType,
      bytes: size,
      exists,
    });
  }

  const lines = [];
  const images = resolvedAttachments.filter((a) => a.kind === "image");
  const files = resolvedAttachments.filter((a) => a.kind !== "image");
  if (images.length > 0) {
    lines.push("Attached images:");
    for (const img of images) {
      lines.push(`- ${img.name} (${img.path})`);
    }
  }
  if (files.length > 0) {
    lines.push("Attached files (inspect with read tool if needed):");
    for (const file of files) {
      lines.push(`- ${file.name} (${file.path})`);
    }
  }

  return {
    attachments: resolvedAttachments,
    visionPayloads,
    imagePaths,
    filePaths,
    promptAppendix: lines.join("\n"),
  };
}

function buildUserMessageContent(promptText = "", visionPayloads = [], style = "anthropic") {
  const text = String(promptText || "");
  if (!Array.isArray(visionPayloads) || visionPayloads.length === 0) {
    return text;
  }
  const blocks = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const v of visionPayloads) {
    if (!v || !v.base64 || !v.mediaType) continue;
    if (style === "openai") {
      blocks.push({
        type: "image_url",
        image_url: {
          url: `data:${v.mediaType};base64,${v.base64}`,
        },
      });
    } else {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: v.mediaType,
          data: v.base64,
        },
      });
    }
  }
  return blocks.length > 0 ? blocks : text;
}

function formatAttachmentPromptSummary(text = "", rawAttachments = []) {
  const cleanText = String(text || "").trim();
  const list = normalizeAttachmentList(rawAttachments);
  if (list.length === 0) return cleanText;
  if (cleanText) return cleanText;
  const labels = list.map((item) => item.name).join(", ");
  return list.every((item) => item.kind === "image")
    ? `Please inspect the attached image${list.length > 1 ? "s" : ""}: ${labels}`
    : `Please inspect the attached file${list.length > 1 ? "s" : ""}: ${labels}`;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_INLINE_VISION_BYTES,
  MAX_FILE_BYTES,
  sniffImageMediaType,
  mediaTypeFromPath,
  stageAttachments,
  normalizeAttachmentList,
  loadAttachmentModelContext,
  buildUserMessageContent,
  formatAttachmentPromptSummary,
};
