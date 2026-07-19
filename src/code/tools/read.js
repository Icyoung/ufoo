const fs = require("fs");
const { resolveWorkspacePath } = require("./common");

const MAX_FULL_READ_BYTES = 4 * 1024 * 1024;

function readFileBounded(resolved) {
  const stat = fs.statSync(resolved);
  if (stat.size <= MAX_FULL_READ_BYTES) {
    return { raw: fs.readFileSync(resolved, "utf8"), partial: false };
  }
  const fd = fs.openSync(resolved, "r");
  try {
    const buffer = Buffer.alloc(MAX_FULL_READ_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_FULL_READ_BYTES, 0);
    return { raw: buffer.slice(0, bytesRead).toString("utf8"), partial: true };
  } finally {
    fs.closeSync(fd);
  }
}

function runReadTool(input = {}, options = {}) {
  try {
    const filePath = String(input.path || input.file || "").trim();
    const { workspaceRoot, resolved } = resolveWorkspacePath(options.workspaceRoot, filePath, options.cwd);
    const startLine = Number.isFinite(input.startLine) ? Math.max(1, Math.floor(input.startLine)) : 1;
    const endLine = Number.isFinite(input.endLine) ? Math.max(startLine, Math.floor(input.endLine)) : 0;
    const maxBytes = Number.isFinite(input.maxBytes) ? Math.max(256, Math.floor(input.maxBytes)) : 200000;

    const { raw, partial } = readFileBounded(resolved);
    const lines = raw.split(/\r?\n/);
    const from = startLine - 1;
    const to = endLine > 0 ? endLine : lines.length;
    const selected = lines.slice(from, to);
    let content = selected.join("\n");
    let truncated = partial;
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      content = Buffer.from(content, "utf8").slice(0, maxBytes).toString("utf8");
      truncated = true;
    }

    return {
      ok: true,
      workspaceRoot,
      path: resolved,
      startLine,
      endLine: endLine > 0 ? endLine : lines.length,
      totalLines: lines.length,
      truncated,
      content,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "read failed",
    };
  }
}

module.exports = {
  runReadTool,
  MAX_FULL_READ_BYTES,
};
