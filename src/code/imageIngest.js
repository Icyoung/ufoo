"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { mediaTypeFromPath, sniffMediaType, MAX_IMAGE_BYTES } = require("./tools/readImage");

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const FILE_URL_RE = /^file:\/\//i;

function uploadsDir(workspaceRoot = "", sessionId = "") {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  const sid = String(sessionId || "session").trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
  return path.join(root, ".ufoo", "agent", "ucode", "uploads", sid);
}

function safeBaseName(filePath = "") {
  const base = path.basename(String(filePath || "image.png"));
  const cleaned = base.replace(/[^\w.\-()+ ]+/g, "_").replace(/\s+/g, " ").trim();
  if (!cleaned) return "image.png";
  if (!IMAGE_EXT_RE.test(cleaned)) return `${cleaned}.png`;
  return cleaned.slice(0, 120);
}

function decodeFileUrl(value = "") {
  const text = String(value || "").trim();
  if (!FILE_URL_RE.test(text)) return text;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "file:") return text;
    return decodeURIComponent(parsed.pathname || "");
  } catch {
    return text.replace(FILE_URL_RE, "");
  }
}

function looksLikeImagePath(candidate = "") {
  const text = decodeFileUrl(String(candidate || "").trim().replace(/^['"]|['"]$/g, ""));
  if (!text || !IMAGE_EXT_RE.test(text)) return false;
  if (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("~")) return true;
  // Relative paths ending in image ext (drag from cwd listings)
  if (!/\s/.test(text) && IMAGE_EXT_RE.test(text)) return true;
  return false;
}

function expandHome(filePath = "") {
  const text = String(filePath || "");
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

// Parse terminal shell quoting without evaluating shell expressions. Keep source
// spans so the exact pasted spelling (including escapes) can be removed later.
function imagePathMatches(text = "") {
  const raw = String(text || "");
  const matches = [];
  let offset = 0;
  for (const line of raw.split(/\n/)) {
    const tokens = [];
    let i = 0;
    while (i < line.length) {
      if (/\s/.test(line[i])) { i += 1; continue; }
      const start = i;
      let value = "";
      let quote = "";
      const windowsPath = /^[A-Za-z]:[\\/]/.test(line.slice(i).replace(/^["']/, ""));
      while (i < line.length) {
        const ch = line[i];
        if (!quote && /\s/.test(ch)) break;
        if (ch === quote) { quote = ""; i += 1; continue; }
        if (!quote && (ch === "'" || ch === '"')) { quote = ch; i += 1; continue; }
        if (ch === "\\" && quote !== "'" && !windowsPath && i + 1 < line.length
          && (!quote || /[\\"$`]/.test(line[i + 1]))) {
          value += line[i + 1];
          i += 2;
          continue;
        }
        value += ch;
        i += 1;
      }
      tokens.push({ value, start: offset + start, end: offset + i });
    }
    const trimmed = line.trim();
    // Preserve support for a raw, unquoted absolute filename containing spaces.
    // Escaped or quoted terminal input always uses the tokenized path above.
    const rawWholePath = !/[\\"']/.test(trimmed)
      && looksLikeImagePath(trimmed)
      && tokens.filter((token) => looksLikeImagePath(token.value)).length < 2
      && !tokens.slice(1).some((token) => /^(?:\/|file:\/\/|~\/)/.test(token.value));
    const candidates = rawWholePath
      ? [{ value: trimmed, start: offset + line.indexOf(trimmed), end: offset + line.indexOf(trimmed) + trimmed.length }]
      : tokens;
    for (const token of candidates) {
      if (!looksLikeImagePath(token.value)) continue;
      matches.push({ ...token, path: expandHome(decodeFileUrl(token.value)) });
    }
    offset += line.length + 1;
  }
  return matches;
}

function extractImagePathsFromPaste(text = "") {
  const seen = new Set();
  return imagePathMatches(text).flatMap((match) => {
    const key = path.resolve(match.path);
    if (seen.has(key)) return [];
    seen.add(key);
    return [match.path];
  });
}

function stripExtractedPathsFromText(text = "", paths = []) {
  let out = String(text || "");
  const selected = new Set(paths.map((p) => path.resolve(p)));
  const matches = imagePathMatches(out).filter((match) => selected.has(path.resolve(match.path)));
  for (const match of matches.reverse()) {
    out = `${out.slice(0, match.start)} ${out.slice(match.end)}`;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ").trim();
}

function formatImageLogLabel(_attachment = {}, index = 0) {
  return `[Image #${index + 1}]`;
}

function formatUserLogWithAttachments(userText = "", attachments = []) {
  const labels = (Array.isArray(attachments) ? attachments : [])
    .map((item, index) => formatImageLogLabel(item, index))
    .filter(Boolean);
  const body = String(userText || "").trim();
  if (labels.length === 0) return body;
  if (!body) return labels.join(" ");
  return `${labels.join(" ")} ${body}`;
}

function buildAttachedImagesPromptPrefix(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return "";
  const lines = [
    "[Attached images — call read_image on each path]",
    ...list.map((item) => `- ${item.relPath || item.path || ""}`).filter((line) => line !== "- "),
    "",
  ];
  return lines.join("\n");
}

function ingestImageFile({
  sourcePath = "",
  workspaceRoot = process.cwd(),
  sessionId = "",
  buffer = null,
  preferredName = "",
} = {}) {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  let data = buffer;
  let fromPath = String(sourcePath || "").trim();

  if (!data) {
    if (!fromPath) {
      return { ok: false, error: "sourcePath or buffer required" };
    }
    fromPath = expandHome(decodeFileUrl(fromPath));
    try {
      const stat = fs.statSync(fromPath);
      if (!stat.isFile()) return { ok: false, error: `not a file: ${fromPath}` };
      if (stat.size > MAX_IMAGE_BYTES) {
        return {
          ok: false,
          error: `image too large (${stat.size} bytes); max ${MAX_IMAGE_BYTES}`,
        };
      }
      data = fs.readFileSync(fromPath);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : "read failed" };
    }
  }

  if (!Buffer.isBuffer(data)) {
    return { ok: false, error: "image buffer required" };
  }
  if (data.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image too large (${data.length} bytes); max ${MAX_IMAGE_BYTES}`,
    };
  }

  const sniffed = sniffMediaType(data);
  const fromName = mediaTypeFromPath(preferredName || fromPath);
  const mediaType = sniffed || fromName;
  if (!mediaType) {
    return { ok: false, error: "unsupported image type (use png, jpeg, gif, or webp)" };
  }

  const ext = mediaType === "image/jpeg"
    ? ".jpg"
    : mediaType === "image/gif"
      ? ".gif"
      : mediaType === "image/webp"
        ? ".webp"
        : ".png";

  let base = safeBaseName(preferredName || fromPath || `clipboard${ext}`);
  if (!IMAGE_EXT_RE.test(base)) base = `${base}${ext}`;
  // Normalize extension to sniffed type
  base = `${path.basename(base, path.extname(base))}${ext}`;

  const dir = uploadsDir(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const destName = `${stamp}-${base}`;
  const absPath = path.join(dir, destName);
  fs.writeFileSync(absPath, data);

  const relPath = path.relative(root, absPath).split(path.sep).join("/");
  return {
    ok: true,
    relPath,
    absPath,
    fileName: base,
    mediaType,
    bytes: data.length,
  };
}

function tryIngestClipboardImage({
  workspaceRoot = process.cwd(),
  sessionId = "",
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  if (platform !== "darwin") {
    return { ok: false, error: "clipboard image ingest is only supported on macOS" };
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `ufoo-clipboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`,
  );
  // AppleScript: write clipboard PNGf to a temp file.
  const script = [
    `set outPath to POSIX file ${JSON.stringify(tmpPath)}`,
    "try",
    "  set pngData to the clipboard as «class PNGf»",
    "  set fileRef to open for access outPath with write permission",
    "  set eof of fileRef to 0",
    "  write pngData to fileRef",
    "  close access fileRef",
    '  return "ok"',
    "on error errMsg number errNum",
    "  try",
    "    close access outPath",
    "  end try",
    '  return "err:" & errMsg',
    "end try",
  ].join("\n");

  let resultText = "";
  try {
    resultText = String(execFile("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }) || "").trim();
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return {
      ok: false,
      error: err && err.message ? err.message : "clipboard read failed",
    };
  }

  if (!resultText.startsWith("ok")) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return {
      ok: false,
      error: resultText.replace(/^err:/, "").trim() || "no PNG image on clipboard",
    };
  }

  try {
    const ingested = ingestImageFile({
      sourcePath: tmpPath,
      workspaceRoot,
      sessionId,
      preferredName: `clipboard-${Date.now().toString(36)}.png`,
    });
    return ingested;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Handle a paste chunk: ingest image paths and/or macOS clipboard bitmap.
 * Returns text to insert into the editor (paths removed) plus attachments.
 */
function handleImagePaste(text = "", {
  workspaceRoot = process.cwd(),
  sessionId = "",
  tryClipboard = true,
  platform = process.platform,
  execFile = execFileSync,
} = {}) {
  const raw = String(text || "");
  const paths = extractImagePathsFromPaste(raw);
  const attachments = [];
  const errors = [];
  const importedPaths = [];

  for (const sourcePath of paths) {
    const ingested = ingestImageFile({ sourcePath, workspaceRoot, sessionId });
    if (ingested.ok) {
      attachments.push(ingested);
      importedPaths.push(sourcePath);
    }
    else errors.push(ingested.error || "ingest failed");
  }

  let remaining = stripExtractedPathsFromText(raw, importedPaths);

  // If paste had no usable text/paths, try clipboard PNG (Cmd+V of a screenshot).
  const trimmedRemaining = remaining.trim();
  const looksEmptyOrBinary = !trimmedRemaining
    || /[\x00-\x08\x0e-\x1f]/.test(raw)
    || (Buffer.byteLength(raw, "utf8") > 200 && paths.length === 0 && !/\s/.test(raw.slice(0, 40)));

  if (tryClipboard && paths.length === 0 && attachments.length === 0 && looksEmptyOrBinary) {
    const clip = tryIngestClipboardImage({
      workspaceRoot,
      sessionId,
      platform,
      execFile,
    });
    if (clip.ok) {
      attachments.push(clip);
      remaining = "";
    } else if (paths.length === 0 && !trimmedRemaining) {
      errors.push(clip.error || "clipboard ingest failed");
    }
  }

  return {
    text: remaining,
    attachments,
    errors,
  };
}

module.exports = {
  IMAGE_EXT_RE,
  uploadsDir,
  safeBaseName,
  extractImagePathsFromPaste,
  stripExtractedPathsFromText,
  formatImageLogLabel,
  formatUserLogWithAttachments,
  buildAttachedImagesPromptPrefix,
  ingestImageFile,
  tryIngestClipboardImage,
  handleImagePaste,
};
