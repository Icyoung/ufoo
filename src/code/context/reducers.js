"use strict";

const PREVIEW_MAX_CHARS = 600;
const MODEL_PAYLOAD_MAX_CHARS = 4000;

function clipText(value = "", maxChars = PREVIEW_MAX_CHARS) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function tailLines(text = "", count = 20) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length <= count) return lines.join("\n");
  return lines.slice(-count).join("\n");
}

function isTestCommand(command = "", stdout = "") {
  return /\b(npm test|pnpm test|yarn test|npx jest|jest|vitest|mocha|pytest|cargo test|go test)\b/i.test(command)
    || /\b\d+\s+(passed|failed)\b/i.test(stdout)
    || /FAIL|PASS|Tests:/i.test(stdout);
}

function isGitDiffCommand(command = "") {
  return /\bgit\s+(?:diff|show)\b/i.test(String(command || ""));
}

function isSearchCommand(command = "") {
  return /\b(rg|ripgrep|grep|ag|ack)\b/i.test(String(command || ""));
}

function extractTestFailures(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`;
  const failures = [];
  const patterns = [
    /●\s+([^\n]+)/g,
    /FAIL\s+([^\n]+)/g,
    /(?:AssertionError|Error):\s*([^\n]+)/g,
    /FAILED\s+([^\n]+)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      const title = String(match[1] || "").trim();
      if (!title || failures.some((item) => item.title === title)) continue;
      failures.push({ title: title.slice(0, 240) });
      if (failures.length >= 12) return failures;
    }
  }
  return failures;
}

function parseGitDiffFiles(stdout = "") {
  const files = [];
  const lines = String(stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      const pathText = String(diffMatch[2] || diffMatch[1] || "").trim();
      if (pathText && !files.includes(pathText)) files.push(pathText);
      continue;
    }
    const statusMatch = line.match(/^[AMD]\t(.+)$/);
    if (statusMatch) {
      const pathText = String(statusMatch[1] || "").trim();
      if (pathText && !files.includes(pathText)) files.push(pathText);
    }
  }
  return files.slice(0, 80);
}

function parseSearchMatches(stdout = "") {
  const matches = [];
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([^:]+):(\d+)(?::(\d+))?:(.*)$/);
    if (!match) continue;
    matches.push({
      path: match[1],
      line: Number(match[2]),
      column: match[3] ? Number(match[3]) : undefined,
      text: String(match[4] || "").trim().slice(0, 200),
    });
    if (matches.length >= 40) break;
  }
  return matches;
}

function reduceReadResult(raw = {}, artifactId = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const content = String(source.content || "");
  const preview = clipText(content, PREVIEW_MAX_CHARS);
  const modelPayload = {
    ok: source.ok !== false,
    artifactId,
    path: source.path || "",
    startLine: source.startLine,
    endLine: source.endLine,
    totalLines: source.totalLines,
    truncated: Boolean(source.truncated),
    fileHash: source.fileHash || "",
    preview,
  };
  if (content && content.length <= MODEL_PAYLOAD_MAX_CHARS) {
    modelPayload.content = content;
  } else if (content) {
    modelPayload.content = clipText(content, MODEL_PAYLOAD_MAX_CHARS);
    modelPayload.contentTruncated = true;
  }
  if (source.error) modelPayload.error = String(source.error);
  return {
    preview,
    summary: `read ${source.path || "file"} (${source.totalLines || "?"} lines)`,
    modelPayload,
  };
}

function reduceTestResult(raw = {}, artifactId = "", args = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const stdout = String(source.stdout || "");
  const stderr = String(source.stderr || "");
  const failedMatch = stdout.match(/(\d+)\s+failed/i) || stderr.match(/(\d+)\s+failed/i);
  const passedMatch = stdout.match(/(\d+)\s+passed/i) || stderr.match(/(\d+)\s+passed/i);
  const failures = extractTestFailures(stdout, stderr);
  const preview = clipText(
    [stdout ? `stdout:\n${tailLines(stdout, 12)}` : "", stderr ? `stderr:\n${tailLines(stderr, 8)}` : ""]
      .filter(Boolean)
      .join("\n"),
    PREVIEW_MAX_CHARS,
  );
  return {
    preview,
    summary: `test exit=${source.code ?? source.exitCode ?? "?"} failed=${failedMatch ? failedMatch[1] : failures.length}`,
    modelPayload: {
      ok: source.ok !== false,
      artifactId,
      kind: "test",
      exitCode: source.code ?? source.exitCode ?? null,
      passed: passedMatch ? Number(passedMatch[1]) : undefined,
      failed: failedMatch ? Number(failedMatch[1]) : failures.length || undefined,
      failures,
      stdoutTail: tailLines(stdout, 24),
      stderrTail: tailLines(stderr, 12),
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceGitDiffResult(raw = {}, artifactId = "", args = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const stdout = String(source.stdout || "");
  const files = parseGitDiffFiles(stdout);
  const preview = clipText(
    files.length > 0
      ? `git diff files (${files.length}):\n${files.slice(0, 20).join("\n")}`
      : tailLines(stdout, 20),
    PREVIEW_MAX_CHARS,
  );
  return {
    preview,
    summary: `git diff files=${files.length}`,
    modelPayload: {
      ok: source.ok !== false,
      artifactId,
      kind: "git_diff",
      exitCode: source.code ?? source.exitCode ?? null,
      files,
      // Current diff stays complete in artifact; model gets file list + short preview.
      stdoutTail: tailLines(stdout, 40),
      stderrTail: tailLines(String(source.stderr || ""), 8),
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceSearchResult(raw = {}, artifactId = "", args = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const stdout = String(source.stdout || "");
  const matches = parseSearchMatches(stdout);
  const preview = clipText(
    matches.length > 0
      ? matches.slice(0, 12).map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")
      : tailLines(stdout, 20),
    PREVIEW_MAX_CHARS,
  );
  return {
    preview,
    summary: `search matches=${matches.length}`,
    modelPayload: {
      ok: source.ok !== false,
      artifactId,
      kind: "search",
      exitCode: source.code ?? source.exitCode ?? null,
      matchCount: matches.length,
      matches,
      stdoutTail: tailLines(stdout, 20),
      stderrTail: tailLines(String(source.stderr || ""), 8),
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceBashResult(raw = {}, artifactId = "", args = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const stdout = String(source.stdout || "");
  const stderr = String(source.stderr || "");
  const command = String((args && args.command) || source.command || "");

  if (isTestCommand(command, stdout)) {
    return reduceTestResult(raw, artifactId, args);
  }
  if (isGitDiffCommand(command)) {
    return reduceGitDiffResult(raw, artifactId, args);
  }
  if (isSearchCommand(command)) {
    return reduceSearchResult(raw, artifactId, args);
  }

  const preview = clipText(
    [stdout ? `stdout:\n${tailLines(stdout, 8)}` : "", stderr ? `stderr:\n${tailLines(stderr, 8)}` : ""]
      .filter(Boolean)
      .join("\n"),
    PREVIEW_MAX_CHARS,
  );
  return {
    preview,
    summary: `bash exit=${source.code ?? source.exitCode ?? "?"}`,
    modelPayload: {
      ok: source.ok !== false,
      artifactId,
      exitCode: source.code ?? source.exitCode ?? null,
      stdoutTail: tailLines(stdout, 20),
      stderrTail: tailLines(stderr, 20),
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceWriteResult(raw = {}, artifactId = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const preview = `write ${source.path || "file"} (${source.bytes || 0} bytes)`;
  return {
    preview,
    summary: preview,
    modelPayload: {
      ok: source.ok !== false,
      artifactId,
      path: source.path || "",
      mode: source.mode,
      bytes: source.bytes,
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceEditResult(raw = {}, artifactId = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const preview = `edit ${source.path || "file"} changed=${Boolean(source.changed)}`;
  return {
    preview,
    summary: preview,
    modelPayload: {
      ok: source.ok !== false,
      artifactId,
      path: source.path || "",
      changed: Boolean(source.changed),
      replacements: source.replacements,
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceArtifactReadResult(raw = {}, artifactId = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const content = String(source.content || "");
  return {
    preview: clipText(content, PREVIEW_MAX_CHARS),
    summary: `artifact_read ${source.artifactId || artifactId}`,
    modelPayload: {
      ok: source.ok !== false,
      artifactId: source.artifactId || artifactId,
      content: clipText(content, MODEL_PAYLOAD_MAX_CHARS),
      range: source.range,
      truncated: Boolean(source.truncated),
      error: source.error ? String(source.error) : undefined,
    },
  };
}

function reduceReadImageResult(raw = {}, artifactId = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const pathText = String(source.path || "").trim();
  const mediaType = String(source.mediaType || "").trim();
  const bytes = Number.isFinite(source.bytes) ? source.bytes : null;
  const preview = source.ok === false
    ? clipText(String(source.error || "read_image failed"), PREVIEW_MAX_CHARS)
    : clipText(
      `image ${pathText || "file"} (${mediaType || "unknown"}, ${bytes != null ? `${bytes} bytes` : "size?"})`,
      PREVIEW_MAX_CHARS,
    );
  const modelPayload = {
    ok: source.ok !== false,
    kind: "image",
    artifactId,
    path: pathText,
    mediaType,
    bytes,
    preview,
  };
  if (source.error) modelPayload.error = String(source.error);
  // Keep base64 in the in-memory model payload for the current turn only.
  // Artifacts / transcript strip it via stripVisionBase64 before persistence.
  if (modelPayload.ok && source.base64) {
    modelPayload.base64 = String(source.base64);
  }
  return {
    preview,
    summary: `read_image ${pathText || "file"} (${mediaType || "image"})`,
    modelPayload,
  };
}

function reduceToolResult(tool = "", raw = {}, artifactId = "", args = {}) {
  const name = String(tool || "").trim().toLowerCase();
  if (name === "read") return reduceReadResult(raw, artifactId);
  if (name === "read_image") return reduceReadImageResult(raw, artifactId);
  if (name === "bash") return reduceBashResult(raw, artifactId, args);
  if (name === "write") return reduceWriteResult(raw, artifactId);
  if (name === "edit") return reduceEditResult(raw, artifactId);
  if (name === "artifact_read") return reduceArtifactReadResult(raw, artifactId);
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return {
    preview: clipText(text, PREVIEW_MAX_CHARS),
    summary: `${name || "tool"} result`,
    modelPayload: {
      ok: raw && raw.ok !== false,
      artifactId,
      preview: clipText(text, MODEL_PAYLOAD_MAX_CHARS),
    },
  };
}

module.exports = {
  PREVIEW_MAX_CHARS,
  MODEL_PAYLOAD_MAX_CHARS,
  clipText,
  isTestCommand,
  isGitDiffCommand,
  isSearchCommand,
  extractTestFailures,
  parseGitDiffFiles,
  parseSearchMatches,
  reduceToolResult,
  reduceReadResult,
  reduceReadImageResult,
  reduceBashResult,
  reduceTestResult,
  reduceGitDiffResult,
  reduceSearchResult,
  reduceWriteResult,
  reduceEditResult,
  reduceArtifactReadResult,
};
