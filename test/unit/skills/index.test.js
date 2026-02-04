const SkillsManager = require('../../../src/skills');
const fs = require('fs');
const path = require('path');

describe('SkillsManager', () => {
  const testRepoRoot = '/tmp/ufoo-skills-test';
  let manager;
  let consoleLogSpy;

  beforeEach(() => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRepoRoot, { recursive: true });

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    if (fs.existsSync(testRepoRoot)) {
      fs.rmSync(testRepoRoot, { recursive: true, force: true });
    }
    consoleLogSpy.mockRestore();
  });

  describe('findSkillRoots', () => {
    it('should find SKILLS directory in repo root', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(skillsDir);

      manager = new SkillsManager(testRepoRoot);

      expect(manager.skillRoots).toContain(skillsDir);
    });

    it('should find SKILLS in modules directories', () => {
      const modulesDir = path.join(testRepoRoot, 'modules');
      const module1Skills = path.join(modulesDir, 'module1', 'SKILLS');
      const module2Skills = path.join(modulesDir, 'module2', 'SKILLS');

      fs.mkdirSync(module1Skills, { recursive: true });
      fs.mkdirSync(module2Skills, { recursive: true });

      manager = new SkillsManager(testRepoRoot);

      expect(manager.skillRoots).toContain(module1Skills);
      expect(manager.skillRoots).toContain(module2Skills);
    });

    it('should return empty array if no SKILLS directories exist', () => {
      manager = new SkillsManager(testRepoRoot);

      expect(manager.skillRoots).toEqual([]);
    });

    it('should skip modules without SKILLS directory', () => {
      const modulesDir = path.join(testRepoRoot, 'modules');
      const module1 = path.join(modulesDir, 'module1');
      const module2Skills = path.join(modulesDir, 'module2', 'SKILLS');

      fs.mkdirSync(module1, { recursive: true });
      fs.mkdirSync(module2Skills, { recursive: true });

      manager = new SkillsManager(testRepoRoot);

      expect(manager.skillRoots).not.toContain(path.join(module1, 'SKILLS'));
      expect(manager.skillRoots).toContain(module2Skills);
    });

    it('should find both root and module SKILLS directories', () => {
      const rootSkills = path.join(testRepoRoot, 'SKILLS');
      const moduleSkills = path.join(testRepoRoot, 'modules', 'test', 'SKILLS');

      fs.mkdirSync(rootSkills, { recursive: true });
      fs.mkdirSync(moduleSkills, { recursive: true });

      manager = new SkillsManager(testRepoRoot);

      expect(manager.skillRoots).toHaveLength(2);
      expect(manager.skillRoots).toContain(rootSkills);
      expect(manager.skillRoots).toContain(moduleSkills);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(skillsDir, { recursive: true });
      manager = new SkillsManager(testRepoRoot);
    });

    it('should return empty array if no skills', () => {
      const skills = manager.list();
      expect(skills).toEqual([]);
    });

    it('should list all skill directories', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(path.join(skillsDir, 'skill1'));
      fs.mkdirSync(path.join(skillsDir, 'skill2'));
      fs.mkdirSync(path.join(skillsDir, 'skill3'));

      const skills = manager.list();

      expect(skills).toHaveLength(3);
      expect(skills).toContain('skill1');
      expect(skills).toContain('skill2');
      expect(skills).toContain('skill3');
    });

    it('should ignore files in SKILLS directory', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(path.join(skillsDir, 'skill1'));
      fs.writeFileSync(path.join(skillsDir, 'README.md'), 'test', 'utf8');

      const skills = manager.list();

      expect(skills).toEqual(['skill1']);
      expect(skills).not.toContain('README.md');
    });

    it('should return sorted list', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(path.join(skillsDir, 'zebra'));
      fs.mkdirSync(path.join(skillsDir, 'alpha'));
      fs.mkdirSync(path.join(skillsDir, 'beta'));

      const skills = manager.list();

      expect(skills).toEqual(['alpha', 'beta', 'zebra']);
    });

    it('should deduplicate skills from multiple roots', () => {
      const rootSkills = path.join(testRepoRoot, 'SKILLS');
      const moduleSkills = path.join(testRepoRoot, 'modules', 'test', 'SKILLS');

      fs.mkdirSync(path.join(rootSkills, 'skill1'), { recursive: true });
      fs.mkdirSync(path.join(moduleSkills, 'skill1'), { recursive: true });
      fs.mkdirSync(path.join(moduleSkills, 'skill2'), { recursive: true });

      manager = new SkillsManager(testRepoRoot);
      const skills = manager.list();

      expect(skills).toEqual(['skill1', 'skill2']);
    });

    it('should handle non-existent skill root gracefully', () => {
      // Force a non-existent root
      manager.skillRoots.push('/nonexistent/SKILLS');

      const skills = manager.list();

      expect(skills).toEqual([]);
    });
  });

  describe('findSkill', () => {
    it('should find skill in root SKILLS directory', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      const skillPath = path.join(skillsDir, 'myskill');
      fs.mkdirSync(skillPath, { recursive: true });

      manager = new SkillsManager(testRepoRoot);
      const found = manager.findSkill('myskill');

      expect(found).toBe(skillPath);
    });

    it('should find skill in module SKILLS directory', () => {
      const moduleSkills = path.join(testRepoRoot, 'modules', 'test', 'SKILLS');
      const skillPath = path.join(moduleSkills, 'myskill');
      fs.mkdirSync(skillPath, { recursive: true });

      manager = new SkillsManager(testRepoRoot);
      const found = manager.findSkill('myskill');

      expect(found).toBe(skillPath);
    });

    it('should return null for non-existent skill', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(skillsDir);

      manager = new SkillsManager(testRepoRoot);
      const found = manager.findSkill('nonexistent');

      expect(found).toBeNull();
    });

    it('should return first found skill from multiple roots', () => {
      const rootSkills = path.join(testRepoRoot, 'SKILLS');
      const rootSkillPath = path.join(rootSkills, 'myskill');
      const moduleSkills = path.join(testRepoRoot, 'modules', 'test', 'SKILLS');
      const moduleSkillPath = path.join(moduleSkills, 'myskill');

      fs.mkdirSync(rootSkillPath, { recursive: true });
      fs.mkdirSync(moduleSkillPath, { recursive: true });

      manager = new SkillsManager(testRepoRoot);
      const found = manager.findSkill('myskill');

      // Should find the first one in skillRoots order
      expect(found).toBeTruthy();
      expect([rootSkillPath, moduleSkillPath]).toContain(found);
    });
  });

  describe('copyRecursive', () => {
    it('should copy directory recursively', () => {
      const srcDir = path.join(testRepoRoot, 'source');
      const destDir = path.join(testRepoRoot, 'dest');

      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'content1', 'utf8');
      fs.writeFileSync(path.join(srcDir, 'file2.txt'), 'content2', 'utf8');

      manager = new SkillsManager(testRepoRoot);
      manager.copyRecursive(srcDir, destDir);

      expect(fs.existsSync(path.join(destDir, 'file1.txt'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'file2.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(destDir, 'file1.txt'), 'utf8')).toBe('content1');
    });

    it('should copy nested directories', () => {
      const srcDir = path.join(testRepoRoot, 'source');
      const destDir = path.join(testRepoRoot, 'dest');

      fs.mkdirSync(path.join(srcDir, 'nested', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'nested', 'deep', 'file.txt'), 'nested', 'utf8');

      manager = new SkillsManager(testRepoRoot);
      manager.copyRecursive(srcDir, destDir);

      expect(fs.existsSync(path.join(destDir, 'nested', 'deep', 'file.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(destDir, 'nested', 'deep', 'file.txt'), 'utf8')).toBe('nested');
    });

    it('should preserve directory structure', () => {
      const srcDir = path.join(testRepoRoot, 'source');
      const destDir = path.join(testRepoRoot, 'dest');

      fs.mkdirSync(path.join(srcDir, 'dir1'), { recursive: true });
      fs.mkdirSync(path.join(srcDir, 'dir2'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'root.txt'), 'root', 'utf8');
      fs.writeFileSync(path.join(srcDir, 'dir1', 'file1.txt'), 'file1', 'utf8');
      fs.writeFileSync(path.join(srcDir, 'dir2', 'file2.txt'), 'file2', 'utf8');

      manager = new SkillsManager(testRepoRoot);
      manager.copyRecursive(srcDir, destDir);

      expect(fs.existsSync(path.join(destDir, 'root.txt'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'dir1', 'file1.txt'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'dir2', 'file2.txt'))).toBe(true);
    });
  });

  describe('installOne', () => {
    beforeEach(() => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      const skillPath = path.join(skillsDir, 'testskill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, 'skill.json'), '{"name":"test"}', 'utf8');

      manager = new SkillsManager(testRepoRoot);
    });

    it('should install single skill', async () => {
      const targetDir = path.join(testRepoRoot, 'target');

      await manager.installOne('testskill', targetDir);

      expect(fs.existsSync(path.join(targetDir, 'testskill', 'skill.json'))).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith('  - testskill');
    });

    it('should throw error for non-existent skill', async () => {
      const targetDir = path.join(testRepoRoot, 'target');

      await expect(manager.installOne('nonexistent', targetDir))
        .rejects.toThrow('Skill not found: nonexistent');
    });

    it('should replace existing skill', async () => {
      const targetDir = path.join(testRepoRoot, 'target');
      const targetSkill = path.join(targetDir, 'testskill');

      // Install first time
      await manager.installOne('testskill', targetDir);

      // Modify target
      fs.writeFileSync(path.join(targetSkill, 'modified.txt'), 'modified', 'utf8');

      // Install again
      await manager.installOne('testskill', targetDir);

      // Should not have modified file
      expect(fs.existsSync(path.join(targetSkill, 'modified.txt'))).toBe(false);
      expect(fs.existsSync(path.join(targetSkill, 'skill.json'))).toBe(true);
    });
  });

  describe('install', () => {
    beforeEach(() => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(path.join(skillsDir, 'skill1'), { recursive: true });
      fs.mkdirSync(path.join(skillsDir, 'skill2'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'skill1', 'file.txt'), 'skill1', 'utf8');
      fs.writeFileSync(path.join(skillsDir, 'skill2', 'file.txt'), 'skill2', 'utf8');

      manager = new SkillsManager(testRepoRoot);
    });

    it('should install to custom target', async () => {
      const targetDir = path.join(testRepoRoot, 'custom-target');

      await manager.install('skill1', { target: targetDir });

      expect(fs.existsSync(path.join(targetDir, 'skill1', 'file.txt'))).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Installing to:'));
    });

    it('should install all skills when name is "all"', async () => {
      const targetDir = path.join(testRepoRoot, 'target');

      await manager.install('all', { target: targetDir });

      expect(fs.existsSync(path.join(targetDir, 'skill1', 'file.txt'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'skill2', 'file.txt'))).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Installed 2 skills'));
    });

    it('should use default claude target if no options', async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testRepoRoot;

      await manager.install('skill1', {});

      const claudeSkills = path.join(testRepoRoot, '.claude', 'skills');
      expect(fs.existsSync(path.join(claudeSkills, 'skill1', 'file.txt'))).toBe(true);

      process.env.HOME = originalHome;
    });

    it('should use codex target when codex option is true', async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testRepoRoot;

      await manager.install('skill1', { codex: true });

      const codexSkills = path.join(testRepoRoot, '.codex', 'skills');
      expect(fs.existsSync(path.join(codexSkills, 'skill1', 'file.txt'))).toBe(true);

      process.env.HOME = originalHome;
    });

    it('should use agents target when agents option is true', async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testRepoRoot;

      await manager.install('skill1', { agents: true });

      const agentsSkills = path.join(testRepoRoot, '.agents', 'skills');
      expect(fs.existsSync(path.join(agentsSkills, 'skill1', 'file.txt'))).toBe(true);

      process.env.HOME = originalHome;
    });

    it('should use CODEX_HOME if set', async () => {
      const originalHome = process.env.HOME;
      const originalCodexHome = process.env.CODEX_HOME;

      process.env.HOME = testRepoRoot;
      const customCodexHome = path.join(testRepoRoot, 'custom-codex');
      process.env.CODEX_HOME = customCodexHome;

      await manager.install('skill1', { codex: true });

      const codexSkills = path.join(customCodexHome, 'skills');
      expect(fs.existsSync(path.join(codexSkills, 'skill1', 'file.txt'))).toBe(true);

      process.env.HOME = originalHome;
      process.env.CODEX_HOME = originalCodexHome;
    });

    it('should create target directory if not exists', async () => {
      const targetDir = path.join(testRepoRoot, 'new', 'nested', 'target');

      await manager.install('skill1', { target: targetDir });

      expect(fs.existsSync(targetDir)).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'skill1', 'file.txt'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty SKILLS directory', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(skillsDir);

      manager = new SkillsManager(testRepoRoot);
      const skills = manager.list();

      expect(skills).toEqual([]);
    });

    it('should handle skill names with special characters', () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      fs.mkdirSync(path.join(skillsDir, 'my-skill_v2'), { recursive: true });

      manager = new SkillsManager(testRepoRoot);
      const skills = manager.list();

      expect(skills).toContain('my-skill_v2');
    });

    it('should handle deeply nested module structure', () => {
      const deepModuleSkills = path.join(testRepoRoot, 'modules', 'level1', 'SKILLS');
      fs.mkdirSync(deepModuleSkills, { recursive: true });
      fs.mkdirSync(path.join(deepModuleSkills, 'skill1'));

      manager = new SkillsManager(testRepoRoot);
      const skills = manager.list();

      expect(skills).toContain('skill1');
    });

    it('should handle skill with complex directory structure', async () => {
      const skillsDir = path.join(testRepoRoot, 'SKILLS');
      const complexSkill = path.join(skillsDir, 'complex');
      fs.mkdirSync(path.join(complexSkill, 'nested', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(complexSkill, 'root.txt'), 'root', 'utf8');
      fs.writeFileSync(path.join(complexSkill, 'nested', 'mid.txt'), 'mid', 'utf8');
      fs.writeFileSync(path.join(complexSkill, 'nested', 'deep', 'leaf.txt'), 'leaf', 'utf8');

      manager = new SkillsManager(testRepoRoot);
      const targetDir = path.join(testRepoRoot, 'target');

      await manager.install('complex', { target: targetDir });

      expect(fs.existsSync(path.join(targetDir, 'complex', 'root.txt'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'complex', 'nested', 'mid.txt'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'complex', 'nested', 'deep', 'leaf.txt'))).toBe(true);
    });
  });
});
