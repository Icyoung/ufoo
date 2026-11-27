"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { canonicalProjectRoot } = require("../projects/projectId");

function runGit(cwd, args = [], timeout = 15000) {
  try {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: String(res.stdout || "").trim(),
      stderr: String(res.stderr || "").trim(),
    };
  } catch (err) {
    return {
      ok: false,
      status: -1,
      stdout: "",
      stderr: err && err.message ? err.message : String(err),
    };
  }
}

function isGitRepository(projectRoot) {
  return runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

function currentGitBranch(cwd) {
  const res = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.ok ? res.stdout : "";
}

function slugifyBranchSegment(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `task-${Date.now().toString(36)}`;
}

/**
 * Pure policy planner for optional worktree allocation:
 * - Default policy is "never": all workers and groups share the project
 *   workspace directly without binding worktrees to agents; models are free to
 *   create and operate across any git worktrees on demand.
 * - Explicit caller opt-in (`explicitMode: "create"|"isolated"|"always"` or
 *   `policy: "always"`) remains supported for callers that explicitly request
 *   an isolated worktree.
 */
function resolveWorkerWorktreePlan({
  projectRoot,
  policy = "never",
  activeWritableCount = 0,
  groupId = "",
  groupWorktreeRoot = "",
  groupBranch = "",
  groupActiveWritableCount = 0,
  readonly = false,
  explicitMode = "",
} = {}) {
  const normalizedPolicy = String(policy || "never").trim().toLowerCase();
  const mode = String(explicitMode || "").trim().toLowerCase();
  const root = String(projectRoot || process.cwd());

  if (readonly) {
    return {
      useWorktree: false,
      cwd: groupWorktreeRoot || root,
      branch: groupBranch || "",
      mode: "readonly_reuse",
    };
  }

  if (mode === "none" || mode === "disable") {
    return {
      useWorktree: false,
      cwd: groupWorktreeRoot || root,
      branch: groupBranch || "",
      mode: "explicit_none",
    };
  }

  if (mode === "create" || mode === "isolated" || mode === "always") {
    return {
      useWorktree: true,
      cwd: root,
      baseBranch: groupBranch || "",
      mode: "explicit_isolated",
    };
  }

  if (normalizedPolicy === "never") {
    return {
      useWorktree: false,
      cwd: root,
      branch: "",
      mode: "shared_workspace",
    };
  }

  if (groupId && groupWorktreeRoot) {
    if (groupActiveWritableCount > 0 || mode === "fork") {
      return {
        useWorktree: true,
        cwd: root,
        baseBranch: groupBranch || "",
        parentGroupRoot: groupWorktreeRoot,
        mode: "group_fork",
      };
    }
    return {
      useWorktree: false,
      cwd: groupWorktreeRoot,
      branch: groupBranch || "",
      mode: "group_shared",
    };
  }

  if (normalizedPolicy === "always") {
    return {
      useWorktree: true,
      cwd: root,
      baseBranch: groupBranch || "",
      mode: "policy_always",
    };
  }

  if (normalizedPolicy === "auto" && activeWritableCount >= 1) {
    return {
      useWorktree: true,
      cwd: root,
      baseBranch: groupBranch || "",
      mode: "auto_concurrent",
    };
  }

  return {
    useWorktree: false,
    cwd: root,
    branch: "",
    mode: "shared_workspace",
  };
}

function createManagedWorktree({
  projectRoot,
  slug = "",
  baseBranch = "",
  branchPrefix = "ufoo/",
} = {}) {
  const root = canonicalProjectRoot(projectRoot);
  if (!isGitRepository(root)) {
    return {
      ok: false,
      skipped: true,
      reason: "not_a_git_repo",
      worktreeRoot: root,
      branch: "",
    };
  }

  const safeSlug = slugifyBranchSegment(slug);
  const worktreesDir = path.join(root, ".ufoo", "worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });

  const uniqueSuffix = Date.now().toString(36).slice(-4);
  const dirName = `${safeSlug}-${uniqueSuffix}`;
  const worktreePath = path.join(worktreesDir, dirName);
  const branchName = `${branchPrefix}${dirName}`;
  const baseRef = String(baseBranch || currentGitBranch(root) || "HEAD").trim();

  const res = runGit(root, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
  if (!res.ok) {
    return {
      ok: false,
      error: res.stderr || res.stdout || "git worktree add failed",
      worktreeRoot: root,
      branch: "",
    };
  }

  return {
    ok: true,
    worktreeRoot: worktreePath,
    branch: branchName,
    baseBranch: baseRef,
  };
}

function removeManagedWorktree({ projectRoot, worktreePath, force = false, deleteBranch = false, branch = "" } = {}) {
  const root = canonicalProjectRoot(projectRoot);
  const target = path.resolve(String(worktreePath || ""));
  if (!target || target === root) {
    return { ok: false, error: "Cannot remove main workspace worktree" };
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(target);
  const res = runGit(root, args);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || "git worktree remove failed" };
  }
  if (deleteBranch && branch) {
    runGit(root, ["branch", force ? "-D" : "-d", branch]);
  }
  return { ok: true, removed: target };
}

function mergeManagedWorktree({
  projectRoot,
  branch = "",
  targetBranch = "",
  squash = false,
  worktreePath = "",
  removeAfter = false,
} = {}) {
  const root = canonicalProjectRoot(projectRoot);
  const sourceBranch = String(branch || "").trim();
  if (!sourceBranch) {
    return { ok: false, error: "Source branch is required for merge" };
  }
  const current = currentGitBranch(root);
  if (targetBranch && targetBranch !== current) {
    const checkout = runGit(root, ["checkout", targetBranch]);
    if (!checkout.ok) {
      return { ok: false, error: checkout.stderr || `Failed to checkout ${targetBranch}` };
    }
  }
  const mergeArgs = squash
    ? ["merge", "--squash", sourceBranch]
    : ["merge", "--no-ff", sourceBranch, "-m", `Merge ${sourceBranch}`];
  const merged = runGit(root, mergeArgs);
  if (!merged.ok) {
    return { ok: false, error: merged.stderr || merged.stdout || "git merge failed", conflict: true };
  }
  if (removeAfter && worktreePath) {
    removeManagedWorktree({ projectRoot: root, worktreePath, deleteBranch: !squash, branch: sourceBranch });
  }
  return {
    ok: true,
    branch: sourceBranch,
    targetBranch: targetBranch || current,
    squash,
    output: merged.stdout,
  };
}

module.exports = {
  isGitRepository,
  currentGitBranch,
  slugifyBranchSegment,
  resolveWorkerWorktreePlan,
  createManagedWorktree,
  removeManagedWorktree,
  mergeManagedWorktree,
};
