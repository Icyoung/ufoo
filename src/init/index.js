const fs = require("fs");
const path = require("path");

/**
 * ufoo 初始化管理
 */
class UfooInit {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.contextMod = path.join(repoRoot, "modules", "context");
    this.busMod = path.join(repoRoot, "modules", "bus");
    this.resourcesMod = path.join(repoRoot, "modules", "resources");
    this.agentsTemplate = path.join(repoRoot, "modules", "AGENTS.template.md");
  }

  /**
   * 初始化项目
   */
  async init(options = {}) {
    const modules = (options.modules || "context").split(",");
    const project = options.project || process.cwd();

    console.log("=== ufoo init ===");
    console.log(`Project directory: ${project}`);
    console.log(`Modules: ${modules.join(", ")}`);
    console.log();

    // 确保 AGENTS.md 和 CLAUDE.md 存在
    this.ensureAgentsFiles(project);

    // 初始化核心
    this.initCore(project);

    // 初始化 AGENTS.md 模板
    this.injectAgentsTemplate(project);

    // 初始化各模块
    for (const module of modules) {
      switch (module.trim()) {
        case "context":
          this.initContext(project);
          break;
        case "bus":
          await this.initBus(project);
          break;
        case "resources":
          this.initResources(project);
          break;
        default:
          console.error(`Unknown module: ${module}`);
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

    // 创建 AGENTS.md（如果不存在）
    if (!fs.existsSync(agentsFile)) {
      const content = `# Project Instructions

\`CLAUDE.md\` points to this file. Please keep project instructions here (prefer edits in \`AGENTS.md\`).

`;
      fs.writeFileSync(agentsFile, content, "utf8");
    }

    // CLAUDE.md 指向 AGENTS.md
    fs.writeFileSync(claudeFile, "AGENTS.md\n", "utf8");
  }

  /**
   * 初始化核心 .ufoo 目录
   */
  initCore(project) {
    console.log("[core] Initializing .ufoo core...");

    const ufooDir = path.join(project, ".ufoo");
    if (!fs.existsSync(ufooDir)) {
      fs.mkdirSync(ufooDir, { recursive: true });
    }

    // 创建 docs 符号链接
    const docsLink = path.join(ufooDir, "docs");
    const docsTarget = path.join(this.repoRoot, "docs");

    if (fs.existsSync(docsTarget)) {
      if (fs.existsSync(docsLink)) {
        fs.unlinkSync(docsLink);
      }
      fs.symlinkSync(docsTarget, docsLink);
      console.log(`[core] Created docs symlink: .ufoo/docs -> ${docsTarget}`);
    }

    console.log("[core] Done");
  }

  /**
   * 注入 ufoo 模板到 AGENTS.md
   */
  injectAgentsTemplate(project) {
    if (!fs.existsSync(this.agentsTemplate)) {
      console.log("[template] AGENTS.template.md not found, skipping");
      return;
    }

    console.log("[template] Injecting ufoo template into AGENTS.md...");

    const agentsFile = path.join(project, "AGENTS.md");
    let content = fs.readFileSync(agentsFile, "utf8");

    const template = fs.readFileSync(this.agentsTemplate, "utf8");

    // 查找或添加 ufoo 标记块
    const marker = "<!-- ufoo-template -->";
    if (content.includes(marker)) {
      // 替换现有块
      const startIdx = content.indexOf(marker);
      const endIdx = content.indexOf(marker, startIdx + marker.length);

      if (endIdx !== -1) {
        content =
          content.slice(0, startIdx) +
          `${marker}\n${template}\n${marker}` +
          content.slice(endIdx + marker.length);
      } else {
        // 只有开始标记，追加到末尾
        content += `\n${marker}\n${template}\n${marker}\n`;
      }
    } else {
      // 追加到末尾
      content += `\n${marker}\n${template}\n${marker}\n`;
    }

    fs.writeFileSync(agentsFile, content, "utf8");
    console.log("[template] Done");
  }

  /**
   * 初始化 context 模块
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
   * 初始化 bus 模块
   */
  async initBus(project) {
    console.log("[bus] Initializing bus module...");

    const EventBus = require("../bus");
    const bus = new EventBus(project);

    try {
      await bus.init();
      console.log("[bus] Done");
    } catch (err) {
      console.error(`[bus] Error: ${err.message}`);
    }
  }

  /**
   * 初始化 resources 模块
   */
  initResources(project) {
    if (!fs.existsSync(this.resourcesMod)) {
      console.log("[resources] Module not found, skipping");
      return;
    }

    console.log("[resources] Initializing resources module...");

    const targetDir = path.join(project, ".ufoo", "resources");

    // 复制模块内容
    this.copyModuleContent(this.resourcesMod, targetDir);

    console.log("[resources] Done");
  }

  /**
   * 复制模块内容
   */
  copyModuleContent(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    // 复制所有文件和目录（排除 .git、node_modules 等）
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      // 跳过特殊目录
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * 递归复制目录
   */
  copyRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

module.exports = UfooInit;
