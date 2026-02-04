const fs = require("fs");
const path = require("path");
const DecisionsManager = require("./decisions");

/**
 * Context Doctor & Lint
 * 诊断和验证 context 目录结构
 */
class ContextDoctor {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.contextDir = path.join(projectRoot, ".ufoo", "context");
    this.failed = false;
  }

  /**
   * 失败检查
   */
  fail(message) {
    console.error(`FAIL: ${message}`);
    this.failed = true;
  }

  /**
   * 检查文件存在
   */
  checkFile(filePath, name) {
    if (!fs.existsSync(filePath)) {
      this.fail(`Missing file: ${name || filePath}`);
      return false;
    }
    return true;
  }

  /**
   * 检查目录存在
   */
  checkDir(dirPath, name) {
    if (!fs.existsSync(dirPath)) {
      this.fail(`Missing directory: ${name || dirPath}`);
      return false;
    }
    return true;
  }

  /**
   * 检查 glob 模式有匹配
   */
  checkAnyGlob(dir, pattern, name) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.match(pattern));
      if (files.length === 0) {
        this.fail(`Missing: ${name || pattern} in ${dir}`);
        return false;
      }
      return true;
    } catch {
      this.fail(`Cannot read directory: ${dir}`);
      return false;
    }
  }

  /**
   * Lint 项目 context
   */
  lintProject(projectPath) {
    const ctxPath = projectPath || this.contextDir;

    console.log(`Linting project context: ${ctxPath}`);

    // Check basic structure
    this.checkDir(ctxPath, "context directory");
    this.checkFile(path.join(ctxPath, "decisions.jsonl"), "decisions.jsonl");

    // Check decisions directory
    const decisionsDir = DecisionsManager.resolveDecisionsDir(
      this.projectRoot,
      ctxPath
    );
    this.checkDir(decisionsDir, "decisions directory");

    return !this.failed;
  }

  /**
   * Lint 协议 repo（modules/context）
   */
  lintProtocol() {
    const moduleRoot = path.join(this.projectRoot, "modules", "context");

    if (!fs.existsSync(moduleRoot)) {
      console.log("No protocol module found (skipping protocol lint)");
      return true;
    }

    console.log(`Linting protocol repo: ${moduleRoot}`);

    // Check minimal module files
    this.checkFile(path.join(moduleRoot, "README.md"), "README.md");
    this.checkFile(
      path.join(moduleRoot, "SKILLS", "uctx", "SKILL.md"),
      "SKILLS/uctx/SKILL.md"
    );

    return !this.failed;
  }

  /**
   * 运行完整诊断
   */
  async run(options = {}) {
    const { mode = "protocol", projectPath = null } = options;

    console.log("=== context doctor ===");
    console.log(
      "Reminder: If you provide evaluation/recommendation/plan, write a decision before replying."
    );
    console.log("");

    this.failed = false;

    if (mode === "project") {
      if (!projectPath) {
        this.fail("--project requires a path");
        return false;
      }

      console.log("Mode: project");
      console.log(`Project: ${projectPath}`);
      this.lintProject(projectPath);

      // Test decisions listing
      try {
        const decisionsManager = new DecisionsManager(this.projectRoot);
        decisionsManager.decisionsDir = DecisionsManager.resolveDecisionsDir(
          this.projectRoot,
          projectPath
        );
        decisionsManager.show({ num: 1 });
      } catch (err) {
        this.fail(`Decisions check failed: ${err.message}`);
      }
    } else {
      console.log("Mode: protocol");

      // Check protocol module
      this.lintProtocol();

      // Test decisions listing (silent)
      try {
        const decisionsManager = new DecisionsManager(this.projectRoot);
        decisionsManager.show({ num: 1 });
      } catch {
        // Silent
      }
    }

    // Check global modules
    const globalContext = path.join(
      process.env.HOME,
      ".ufoo",
      "modules",
      "context"
    );
    if (!fs.existsSync(globalContext)) {
      console.log("");
      console.log(
        `WARN: ${globalContext} not found (install via ufoo for best UX)`
      );
    }

    console.log("");
    if (this.failed) {
      console.log("Status: FAILED");
      return false;
    } else {
      console.log("Status: OK");
      return true;
    }
  }
}

module.exports = ContextDoctor;
