const fs = require("fs");
const path = require("path");

/**
 * ufoo 初始化管理
 */
class UfooInit {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
  }

  /**
   * 初始化项目
   */
  async init(options = {}) {
    const targets = (options.targets || options.modules || "context")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const project = options.project || process.cwd();
    const controllerMode = options.controllerMode === true;

    console.log("=== ufoo init ===");
    console.log(`Project directory: ${project}`);
    console.log(`Targets: ${targets.join(", ")}`);
    console.log();

    if (!controllerMode) {
      this.ensureAgentsFiles(project);
    }

    // 初始化核心
    this.initCore(project, { controllerMode });

    // Initialize selected workspace features.
    for (const target of targets) {
      switch (target) {
        case "context":
          this.initContext(project);
          break;
        case "bus":
          await this.initBus(project);
          break;
        default:
          console.error(`Unknown init target: ${target}`);
      }
    }

    console.log();
    console.log("✓ Initialization complete");
  }

  /**
   * 确保 AGENTS.md 和 CLAUDE.md 存在
   */
  ensureAgentsFiles(project) {
    const agentsFile = path.join(project, "AGENTS.md");
    const claudeFile = path.join(project, "CLAUDE.md");

    if (!fs.existsSync(agentsFile)) {
      const content = `# Project Instructions

\`CLAUDE.md\` points to this file. Please keep project instructions here (prefer edits in \`AGENTS.md\`).

`;
      fs.writeFileSync(agentsFile, content, "utf8");
    }

    const claudeStat = this.safeLstat(claudeFile);
    if (!claudeStat) {
      fs.writeFileSync(claudeFile, "AGENTS.md\n", "utf8");
    }
  }

  /**
   * 初始化核心 .ufoo 目录
   */
  initCore(project, options = {}) {
    console.log("[core] Initializing .ufoo core...");
    const controllerMode = options.controllerMode === true;

    const ufooDir = path.join(project, ".ufoo");
    if (!fs.existsSync(ufooDir)) {
      fs.mkdirSync(ufooDir, { recursive: true });
    }
    const memoryDir = path.join(ufooDir, "memory");
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    // 创建 docs 符号链接：项目的 docs/ -> .ufoo/docs
    const docsLink = path.join(ufooDir, "docs");
    const projectDocs = path.join(project, "docs");

    if (!controllerMode && fs.existsSync(projectDocs)) {
      const linkStat = this.safeLstat(docsLink);
      if (linkStat) {
        fs.unlinkSync(docsLink);
      }
      fs.symlinkSync(projectDocs, docsLink);
      console.log(`[core] Created docs symlink: .ufoo/docs -> docs/`);
    }

    console.log("[core] Done");
  }

  safeLstat(filePath) {
    try {
      return fs.lstatSync(filePath);
    } catch {
      return null;
    }
  }

  /**
   * 初始化 context
   */
  initContext(project) {
    console.log("[context] Initializing decision-only context...");

    const targetDir = path.join(project, ".ufoo", "context");
    const decisionsDir = path.join(targetDir, "decisions");
    const legacyDir = path.join(targetDir, "DECISIONS");
    const indexFile = path.join(targetDir, "decisions.jsonl");

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    if (!fs.existsSync(decisionsDir) && fs.existsSync(legacyDir)) {
      fs.renameSync(legacyDir, decisionsDir);
    }
    if (!fs.existsSync(decisionsDir)) {
      fs.mkdirSync(decisionsDir, { recursive: true });
    }
    if (!fs.existsSync(indexFile)) {
      fs.writeFileSync(indexFile, "", "utf8");
    }

    console.log("[context] Done");
  }

  /**
   * 初始化 bus
   */
  async initBus(project) {
    console.log("[bus] Initializing bus...");

    const EventBus = require("../../../coordination/bus");
    const bus = new EventBus(project);

    try {
      await bus.init();
      console.log("[bus] Done");
    } catch (err) {
      console.error(`[bus] Error: ${err.message}`);
    }
  }

}

module.exports = UfooInit;
