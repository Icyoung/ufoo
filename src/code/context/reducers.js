"use strict";

const PREVIEW_MAX_CHARS = 600;
const MODEL_PAYLOAD_MAX_CHARS = 16000;
const JSON_ARRAY_FOLD_LIMIT = 12;
const JSON_OBJECT_KEY_LIMIT = 60;
const JSON_STRING_FIELD_MAX_CHARS = 1600;
const BASH_JSON_MAX_CHARS = 3600;
const BASH_STDOUT_MAX_CHARS = 2200;
const BASH_STDERR_MAX_CHARS = 1200;

function looksLikeLargeBase64(value = "") {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 256) return false;
  if (/^data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,/i.test(trimmed)) return true;
  const compact = trimmed.replace(/\r?\n/g, "");
  if (compact.length < 256 || /\s/.test(compact)) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return false;
  // Require a mix of upper, lower, and digits or base64 padding/symbols so
  // ordinary long paths or repeated single-char banners are not misclassified.
  const hasUpper = /[A-Z]/.test(compact);
  const hasLower = /[a-z]/.test(compact);
  const hasDigitOrSym = /[0-9+/=]/.test(compact);
  return hasUpper && hasLower && hasDigitOrSym;
}

function stripEmbeddedBase64(text = "") {
  const source = String(text || "");
  if (!source) return "";
  return source
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{128,}/gi, (match) => `[omitted data-uri base64 (${match.length} chars)]`)
    .replace(/\b[A-Za-z0-9+/]{256,}={0,2}\b/g, (match) => (looksLikeLargeBase64(match) ? `[omitted base64 blob (${match.length} chars)]` : match));
}

function dehydrateJsonValue(value, {
  maxArrayItems = JSON_ARRAY_FOLD_LIMIT,
  maxObjectKeys = JSON_OBJECT_KEY_LIMIT,
  maxStringChars = JSON_STRING_FIELD_MAX_CHARS,
  depth = 0,
} = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (looksLikeLargeBase64(value)) {
      return `[omitted base64 blob (${value.length} chars)]`;
    }
    const cleaned = stripEmbeddedBase64(value);
    return cleaned.length > maxStringChars ? clipText(cleaned, maxStringChars) : cleaned;
  }
  if (typeof value !== "object") return value;
  if (depth >= 8) {
    return Array.isArray(value) ? `[array(${value.length})]` : "[object]";
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, maxArrayItems)
      .map((item) => dehydrateJsonValue(item, { maxArrayItems, maxObjectKeys, maxStringChars, depth: depth + 1 }));
    if (value.length > maxArrayItems) {
      kept.push(`[omitted ${value.length - maxArrayItems} additional items]`);
    }
    return kept;
  }
  const keys = Object.keys(value);
  const out = {};
  const sliceKeys = keys.slice(0, maxObjectKeys);
  for (const key of sliceKeys) {
    out[key] = dehydrateJsonValue(value[key], { maxArrayItems, maxObjectKeys, maxStringChars, depth: depth + 1 });
  }
  if (keys.length > maxObjectKeys) {
    out._omittedKeys = keys.length - maxObjectKeys;
  }
  return out;
}

function compactToolOutputForPrompt(rawText = "", {
  maxArrayItems = JSON_ARRAY_FOLD_LIMIT,
  maxJsonChars = BASH_JSON_MAX_CHARS,
  maxTextChars = BASH_STDOUT_MAX_CHARS,
  tailLineCount = 20,
} = {}) {
  const source = String(rawText || "");
  if (!source) return "";
  const trimmed = source.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const dehydrated = dehydrateJsonValue(parsed, { maxArrayItems });
        const serialized = JSON.stringify(dehydrated, null, 2);
        return clipText(serialized, maxJsonChars);
      }
    } catch {
      // Fall through to text dehydration when output is not valid JSON.
    }
  }
  const stripped = stripEmbeddedBase64(source);
  const tailed = tailLineCount > 0 ? tailLines(stripped, tailLineCount) : stripped;
  return clipText(tailed, maxTextChars);
}

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

  if (source.kind === "background_bash") {
    if (source.action === "list") {
      const processes = Array.isArray(source.processes) ? source.processes : [];
      const runningCount = Number.isFinite(source.runningCount)
        ? source.runningCount
        : processes.filter((item) => item && item.running).length;
      const summary = `bash bg list (${runningCount}/${processes.length} running)`;
      return {
        preview: summary,
        summary,
        modelPayload: {
          ok: source.ok !== false,
          artifactId,
          kind: "background_bash",
          action: "list",
          count: processes.length,
          runningCount,
          processes,
          error: source.error ? String(source.error) : undefined,
        },
      };
    }

    const logOutput = String(source.logOutput ?? stdout);
    const previewLines = tailLines(logOutput, 8);
    const statusLabel = source.status || (source.running ? "running" : "exited");
    const summary = `bash bg ${source.action || "run"} ${source.backgroundId || ""} status=${statusLabel}`.trim();
    const preview = clipText(
      [summary, previewLines ? `logs:\n${previewLines}` : ""].filter(Boolean).join("\n"),
      PREVIEW_MAX_CHARS,
    );
    return {
      preview,
      summary,
      modelPayload: {
        ok: source.ok !== false,
        artifactId,
        kind: "background_bash",
        action: source.action || "run",
        backgroundId: source.backgroundId || "",
        pid: source.pid ?? null,
        running: Boolean(source.running),
        status: statusLabel,
        exitCode: source.exitCode ?? source.code ?? null,
        signal: source.signal || undefined,
        command: source.command || command || undefined,
        logPath: source.logPath || undefined,
        offset: Number.isFinite(source.offset) ? source.offset : 0,
        nextOffset: Number.isFinite(source.nextOffset) ? source.nextOffset : 0,
        totalBytes: Number.isFinite(source.totalBytes) ? source.totalBytes : 0,
        truncated: Boolean(source.truncated) || logOutput.length > 12000,
        logOutput: clipText(logOutput, 12000),
        error: source.error ? String(source.error) : undefined,
      },
    };
  }

  if (isTestCommand(command, stdout)) {
    return reduceTestResult(raw, artifactId, args);
  }
  if (isGitDiffCommand(command)) {
    return reduceGitDiffResult(raw, artifactId, args);
  }
  if (isSearchCommand(command)) {
    return reduceSearchResult(raw, artifactId, args);
  }

  const compactedStdout = compactToolOutputForPrompt(stdout, {
    maxArrayItems: JSON_ARRAY_FOLD_LIMIT,
    maxJsonChars: BASH_JSON_MAX_CHARS,
    maxTextChars: BASH_STDOUT_MAX_CHARS,
    tailLineCount: 20,
  });
  const compactedStderr = compactToolOutputForPrompt(stderr, {
    maxArrayItems: JSON_ARRAY_FOLD_LIMIT,
    maxJsonChars: BASH_STDERR_MAX_CHARS,
    maxTextChars: BASH_STDERR_MAX_CHARS,
    tailLineCount: 20,
  });
  const preview = clipText(
    [compactedStdout ? `stdout:\n${tailLines(compactedStdout, 8)}` : "", compactedStderr ? `stderr:\n${tailLines(compactedStderr, 8)}` : ""]
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
      stdoutTail: compactedStdout,
      stderrTail: compactedStderr,
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
  looksLikeLargeBase64,
  stripEmbeddedBase64,
  dehydrateJsonValue,
  compactToolOutputForPrompt,
};
