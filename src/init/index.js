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

    // 仅在不存在时创建 CLAUDE.md；存在时保留用户文件类型（普通文件或 symlink）
    const claudeStat = this.safeLstat(claudeFile);
    if (!claudeStat) {
      fs.writeFileSync(claudeFile, "AGENTS.md\n", "utf8");
    }
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

    // 创建 docs 符号链接：项目的 docs/ -> .ufoo/docs
    const docsLink = path.join(ufooDir, "docs");
    const projectDocs = path.join(project, "docs");

    if (fs.existsSync(projectDocs)) {
      const linkStat = this.safeLstat(docsLink);
      if (linkStat) {
        fs.unlinkSync(docsLink);
      }
      fs.symlinkSync(projectDocs, docsLink);
      console.log(`[core] Created docs symlink: .ufoo/docs -> docs/`);
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

    const template = fs.readFileSync(this.agentsTemplate, "utf8");
    const targets = this.resolveTemplateTargets(project);
    if (targets.length === 0) {
      console.log("[template] No target markdown files found, skipping");
      return;
    }

    const labels = targets.map((file) => path.relative(project, file) || path.basename(file));
    console.log(`[template] Injecting ufoo template into: ${labels.join(", ")}`);

    for (const file of targets) {
      this.injectTemplateIntoFile(file, template);
    }

    console.log("[template] Done");
  }

  safeLstat(filePath) {
    try {
      return fs.lstatSync(filePath);
    } catch {
      return null;
    }
  }

  resolveTemplateTargets(project) {
    const agentsFile = path.resolve(path.join(project, "AGENTS.md"));
    const claudeFile = path.resolve(path.join(project, "CLAUDE.md"));
    const targets = new Set();

    if (fs.existsSync(agentsFile)) {
      targets.add(agentsFile);
    }

    const claudeStat = this.safeLstat(claudeFile);
    if (!claudeStat) return Array.from(targets);

    if (claudeStat.isSymbolicLink()) {
      try {
        const rawTarget = fs.readlinkSync(claudeFile);
        const sourceFile = path.resolve(path.dirname(claudeFile), rawTarget);
        const projectRoot = path.resolve(project);
        const inProject =
          sourceFile === projectRoot ||
          sourceFile.startsWith(`${projectRoot}${path.sep}`);
        if (inProject) {
          targets.add(sourceFile);
        } else {
          console.warn(`[template] CLAUDE.md symlink target outside project, skipped: ${sourceFile}`);
        }
      } catch {
        // ignore broken symlink
      }
      return Array.from(targets);
    }

    // CLAUDE.md 为独立文件时，双文件都注入模板
    targets.add(claudeFile);
    return Array.from(targets);
  }

  injectTemplateIntoFile(filePath, template) {
    if (!fs.existsSync(filePath)) return;

    let content = fs.readFileSync(filePath, "utf8");
    const marker = "<!-- ufoo-template -->";
    const block = `${marker}\n${template}\n${marker}`;

    if (content.includes(marker)) {
      // Replace existing marker block in-place
      const startIdx = content.indexOf(marker);
      const endIdx = content.indexOf(marker, startIdx + marker.length);
      if (endIdx !== -1) {
        content =
          content.slice(0, startIdx) +
          block +
          content.slice(endIdx + marker.length);
      } else {
        content =
          content.slice(0, startIdx) + block + content.slice(startIdx + marker.length);
      }
    } else {
      // Insert after first heading line for visibility (not buried at end)
      const headingEnd = this.findFirstHeadingEnd(content);
      if (headingEnd !== -1) {
        content =
          content.slice(0, headingEnd) +
          `\n${block}\n\n` +
          content.slice(headingEnd);
      } else {
        content = `${block}\n\n${content}`;
      }
    }
    fs.writeFileSync(filePath, content, "utf8");
  }

  findFirstHeadingEnd(content) {
    // ATX heading: # ... (allow leading indentation and EOF without trailing newline)
    const atxHeading = content.match(/^(?:[ \t]{0,3})#{1,6}[ \t]*[^\n]*(?:\n|$)/m);
    // Setext heading: text line + underline (=== or ---)
    const setextHeading = content.match(/^[^\n]+\n(?:=+|-+)[ \t]*(?:\n|$)/m);

    let bestMatch = null;
    if (atxHeading && setextHeading) {
      bestMatch = atxHeading.index <= setextHeading.index ? atxHeading : setextHeading;
    } else {
      bestMatch = atxHeading || setextHeading;
    }
    if (!bestMatch) return -1;
    return bestMatch.index + bestMatch[0].length;
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
