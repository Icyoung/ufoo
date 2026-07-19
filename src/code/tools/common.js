const fs = require("fs");
const path = require("path");

function normalizeWorkspaceRoot(workspaceRoot = "", cwd = process.cwd()) {
  const base = String(workspaceRoot || "").trim();
  return path.resolve(base || cwd || process.cwd());
}

function isPathInside(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedRoot === normalizedTarget) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

// Realpath the nearest existing ancestor of a path (the path itself when it
// exists). The workspace root always exists by the time tools run, so the
// walk terminates there at the latest.
function realpathNearestExisting(value) {
  let current = value;
  for (;;) {
    const real = realpathOrNull(current);
    if (real) return real;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveWorkspacePath(workspaceRoot = "", targetPath = "", cwd = process.cwd()) {
  const root = normalizeWorkspaceRoot(workspaceRoot, cwd);
  const requested = String(targetPath || "").trim();
  if (!requested) {
    throw new Error("path is required");
  }
  const resolved = path.resolve(root, requested);
  if (!isPathInside(root, resolved)) {
    throw new Error("path escapes workspace root");
  }
  // Lexical checks alone let a symlink inside the workspace point outside
  // (e.g. link -> /etc). Re-validate with real paths: realpath the root too
  // so legit roots behind symlinks (macOS /tmp -> /private/tmp) still pass.
  // For missing files, checking the nearest existing ancestor is enough —
  // the not-yet-created tail cannot contain a symlink.
  const realRoot = realpathOrNull(root);
  if (realRoot) {
    const realTarget = realpathNearestExisting(resolved);
    if (!realTarget || !isPathInside(realRoot, realTarget)) {
      throw new Error("path escapes workspace root");
    }
  }
  return {
    workspaceRoot: root,
    requested,
    resolved,
  };
}

function ensureParentDir(filePath = "") {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  normalizeWorkspaceRoot,
  resolveWorkspacePath,
  ensureParentDir,
};
