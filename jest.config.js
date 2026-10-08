module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/test/setupRegistry.js"],
  modulePathIgnorePatterns: ["/.claude/worktrees/"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/.claude/worktrees/",
  ],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/src/code/tui.js",
  ],
};
