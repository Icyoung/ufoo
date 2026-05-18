module.exports = {
  testEnvironment: "node",
  testPathIgnorePatterns: [
    "/node_modules/",
    "/.claude/worktrees/",
  ],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/src/code/tui.js",
  ],
};
