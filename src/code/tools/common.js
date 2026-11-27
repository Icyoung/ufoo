const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const WORKTREE_CACHE_TTL_MS = 2000;
const worktreeCache = new Map(); // realRoot -> { ts, roots: string[] }

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

/**
 * List canonical real paths of all registered git worktrees (main checkout +
 * any linked worktrees) belonging to the same repository as `realRoot`.
 * Cached briefly so repeated cross-worktree tool calls stay fast.
 */
function listSameRepoWorktreeRoots(realRoot) {
  if (!realRoot) return [];
  const now = Date.now();
  const cached = worktreeCache.get(realRoot);
  if (cached && now - cached.ts < WORKTREE_CACHE_TTL_MS) {
    return cached.roots;
  }
  let roots = [];
  try {
    const res = spawnSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: realRoot,
      encoding: "utf8",
      timeout: 2500,
    });
    if (res.status === 0 && res.stdout) {
      const unique = new Set();
      for (const entry of res.stdout.split("\0")) {
        if (!entry.startsWith("worktree ")) continue;
        const wtPath = entry.slice(9).trim();
        if (!wtPath) continue;
        const canonical = realpathOrNull(wtPath) || path.resolve(wtPath);
        unique.add(canonical);
      }
      roots = [...unique];
    }
  } catch {
    roots = [];
  }
  worktreeCache.set(realRoot, { ts: now, roots });
  return roots;
}

function clearWorktreePathCache() {
  worktreeCache.clear();
}

function resolveWorkspacePath(workspaceRoot = "", targetPath = "", cwd = process.cwd()) {
  const root = normalizeWorkspaceRoot(workspaceRoot, cwd);
  const requested = String(targetPath || "").trim();
  if (!requested) {
    throw new Error("path is required");
  }
  const resolved = path.resolve(root, requested);
  const realRoot = realpathOrNull(root);
  const realTarget = realpathNearestExisting(resolved);

  // Fast path: target is lexically and canonically inside the primary workspaceRoot.
  if (isPathInside(root, resolved)) {
    if (!realRoot || (realTarget && isPathInside(realRoot, realTarget))) {
      return {
        workspaceRoot: root,
        requested,
        resolved,
      };
    }
  }

  // Cross-worktree path: allow free read/write access across any registered git
  // worktree of the same repository (main checkout + model/user-created worktrees)
  // while still strictly rejecting escapes outside all repo worktrees.
  if (realRoot && realTarget) {
    const repoWorktrees = listSameRepoWorktreeRoots(realRoot);
    if (repoWorktrees.length > 0 && repoWorktrees.some((wt) => isPathInside(wt, realRoot))) {
      const matched = repoWorktrees.find((wt) => isPathInside(wt, realTarget));
      if (matched) {
        return {
          workspaceRoot: matched,
          requested,
          resolved,
        };
      }
    }
  }

  throw new Error("path escapes workspace root");
}

function ensureParentDir(filePath = "") {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  normalizeWorkspaceRoot,
  isPathInside,
  resolveWorkspacePath,
  listSameRepoWorktreeRoots,
  clearWorktreePathCache,
  ensureParentDir,
};
