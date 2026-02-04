const fs = require("fs");
const path = require("path");

/**
 * 技能管理
 */
class SkillsManager {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.skillRoots = this.findSkillRoots();
  }

  /**
   * 查找所有技能根目录
   */
  findSkillRoots() {
    const roots = [];

    // 检查 SKILLS 目录
    const mainSkills = path.join(this.repoRoot, "SKILLS");
    if (fs.existsSync(mainSkills)) {
      roots.push(mainSkills);
    }

    // 检查 modules 中的 SKILLS
    const modulesDir = path.join(this.repoRoot, "modules");
    if (fs.existsSync(modulesDir)) {
      const modules = fs.readdirSync(modulesDir);
      for (const module of modules) {
        const moduleSkills = path.join(modulesDir, module, "SKILLS");
        if (fs.existsSync(moduleSkills)) {
          roots.push(moduleSkills);
        }
      }
    }

    return roots;
  }

  /**
   * 列出所有技能
   */
  list() {
    const skills = new Set();

    for (const root of this.skillRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }

      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          skills.add(entry.name);
        }
      }
    }

    return Array.from(skills).sort();
  }

  /**
   * 查找技能路径
   */
  findSkill(name) {
    for (const root of this.skillRoots) {
      const skillPath = path.join(root, name);
      if (fs.existsSync(skillPath)) {
        return skillPath;
      }
    }
    return null;
  }

  /**
   * 安装技能
   */
  async install(name, options = {}) {
    // 确定目标目录
    let target = options.target;

    if (!target) {
      if (options.codex) {
        const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
        target = path.join(codexHome, "skills");
      } else if (options.agents) {
        target = path.join(process.env.HOME, ".agents", "skills");
      } else {
        target = path.join(process.env.HOME, ".claude", "skills");
      }
    }

    console.log(`Installing to: ${target}`);

    // 确保目标目录存在
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    if (name === "all") {
      // 安装所有技能
      const skills = this.list();
      for (const skill of skills) {
        await this.installOne(skill, target);
      }
      console.log(`\nInstalled ${skills.length} skills to ${target}`);
    } else {
      // 安装单个技能
      await this.installOne(name, target);
      console.log(`\nInstalled "${name}" to ${target}`);
    }
  }

  /**
   * 安装单个技能
   */
  async installOne(name, target) {
    const sourcePath = this.findSkill(name);
    if (!sourcePath) {
      throw new Error(`Skill not found: ${name}`);
    }

    const targetPath = path.join(target, name);

    // 如果目标已存在，先删除
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }

    // 复制技能目录
    console.log(`  - ${name}`);
    this.copyRecursive(sourcePath, targetPath);
  }

  /**
   * 递归复制目录
   */
  copyRecursive(src, dest) {
    // 创建目标目录
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
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

module.exports = SkillsManager;
