"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  loadWorkspaceChanges,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitSuggestCommitMessage,
  gitCommit,
} = require("../../../src/ui/workspaceInspector");

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

describe("workspaceInspector Git Review & Commit workflow", () => {
  let repoRoot = "";

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-git-inspector-"));
    git(repoRoot, ["init"]);
    git(repoRoot, ["config", "user.email", "test@ufoo.dev"]);
    git(repoRoot, ["config", "user.name", "ufoo test"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Demo\n", "utf8");
    git(repoRoot, ["add", "README.md"]);
    git(repoRoot, ["commit", "-m", "initial commit"]);
  });

  afterEach(() => {
    if (repoRoot && fs.existsSync(repoRoot)) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("stages, unstages, discards, suggests message, and commits changes", () => {
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Demo\nUpdated line\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "temp.txt"), "scratch\n", "utf8");

    let snap = loadWorkspaceChanges(repoRoot);
    expect(snap.files.map((f) => f.path).sort()).toEqual(["README.md", "temp.txt"]);

    // Discard untracked file
    expect(gitDiscard(repoRoot, { filePath: "temp.txt", kind: "untracked" }).ok).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "temp.txt"))).toBe(false);

    // Stage README.md
    expect(gitStage(repoRoot, { filePath: "README.md" }).ok).toBe(true);
    snap = loadWorkspaceChanges(repoRoot);
    expect(snap.files[0].staged).toBe(true);

    // Unstage README.md
    expect(gitUnstage(repoRoot, { filePath: "README.md" }).ok).toBe(true);
    snap = loadWorkspaceChanges(repoRoot);
    expect(snap.files[0].staged).toBe(false);

    // Suggest commit message
    const suggestion = gitSuggestCommitMessage(repoRoot);
    expect(suggestion.ok).toBe(true);
    expect(suggestion.message).toContain("README.md");

    // Commit change
    const committed = gitCommit(repoRoot, { message: suggestion.message });
    expect(committed.ok).toBe(true);
    expect(committed.sha).toBeTruthy();

    snap = loadWorkspaceChanges(repoRoot);
    expect(snap.files).toHaveLength(0);
  });

  test("refuses git mutations when an explicit worktree path no longer exists instead of falling back to main workspace", () => {
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Demo\nUnsaved main edit\n", "utf8");
    const staleWorktree = path.join(repoRoot, ".ufoo", "worktrees", "deleted-wt");

    const discardRes = gitDiscard(repoRoot, { worktreeRoot: staleWorktree, filePath: "README.md" });
    expect(discardRes.ok).toBe(false);
    expect(discardRes.error).toMatch(/Worktree no longer exists/i);
    // Main workspace file must remain completely untouched
    expect(fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")).toBe("# Demo\nUnsaved main edit\n");

    const stageRes = gitStage(repoRoot, { worktreeRoot: staleWorktree, filePath: "README.md" });
    expect(stageRes.ok).toBe(false);
    expect(stageRes.error).toMatch(/Worktree no longer exists/i);

    const commitRes = gitCommit(repoRoot, { worktreeRoot: staleWorktree, message: "should fail" });
    expect(commitRes.ok).toBe(false);
    expect(commitRes.error).toMatch(/Worktree no longer exists/i);
  });
});
