"use strict";

const { loadArtifact, readArtifactSlice } = require("../context/artifacts");

function runArtifactReadTool(args = {}, options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const sessionId = String(options.sessionId || args.sessionId || "").trim();
  const artifactId = String(args.artifactId || args.id || "").trim();
  if (!artifactId) {
    return { ok: false, error: "artifactId is required" };
  }
  if (!sessionId) {
    return { ok: false, error: "sessionId is required for artifact_read" };
  }

  const loaded = loadArtifact(workspaceRoot, sessionId, artifactId);
  if (!loaded.ok || !loaded.artifact) {
    return { ok: false, error: loaded.error || "artifact not found", artifactId };
  }

  const selector = {};
  if (args.startLine !== undefined) selector.startLine = args.startLine;
  if (args.endLine !== undefined) selector.endLine = args.endLine;
  if (args.maxChars !== undefined) selector.maxChars = args.maxChars;
  if (args.tailLines !== undefined) selector.tailLines = args.tailLines;

  const slice = readArtifactSlice(loaded.artifact, selector);
  return {
    ok: slice.ok !== false,
    artifactId,
    content: slice.content || "",
    range: slice.range,
    truncated: Boolean(slice.truncated),
    error: slice.error || "",
  };
}

module.exports = {
  runArtifactReadTool,
};
