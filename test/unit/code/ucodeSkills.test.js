const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildSkillInjections,
  listUcodeSkills,
  renderSkillsSection,
} = require("../../../src/code/skills");

function writeSkill(root, relDir, { name = relDir, description = `${relDir} description`, body = "skill body" } = {}) {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  short-description: short ${name}\n---\n\n${body}\n`, "utf8");
  return file;
}

describe("ucode skills", () => {
  let tmp;
  let home;
  let codexHome;
  let repoRoot;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-skills-"));
    home = path.join(tmp, "home");
    codexHome = path.join(tmp, "codex-home");
    repoRoot = path.join(tmp, "ufoo-repo");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("discovers repo skills with required frontmatter", () => {
    const workspace = path.join(tmp, "workspace");
    writeSkill(path.join(workspace, ".agents", "skills"), "demo", {
      name: "demo",
      description: "Demo workflow",
      body: "Demo body",
    });

    const outcome = listUcodeSkills({
      workspaceRoot: workspace,
      env: { HOME: home, CODEX_HOME: codexHome },
      repoRoot,
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.skills).toHaveLength(1);
    expect(outcome.skills[0]).toEqual(expect.objectContaining({
      name: "demo",
      description: "Demo workflow",
      shortDescription: "short demo",
      scope: "repo",
      source: "workspace-agents",
    }));
    expect(outcome.skills[0].path.endsWith("SKILL.md")).toBe(true);
  });

  test("discovers codex system skills from explicit .system root", () => {
    const workspace = path.join(tmp, "workspace");
    writeSkill(path.join(codexHome, "skills", ".system"), "sys-skill", {
      name: "sys-skill",
      description: "System skill",
      body: "System body",
    });

    const outcome = listUcodeSkills({
      workspaceRoot: workspace,
      env: { HOME: home, CODEX_HOME: codexHome },
      repoRoot,
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.skills).toHaveLength(1);
    expect(outcome.skills[0]).toEqual(expect.objectContaining({
      name: "sys-skill",
      scope: "system",
      source: "codex-system",
    }));
  });

  test("invalid skills produce warnings without crashing", () => {
    const workspace = path.join(tmp, "workspace");
    const brokenDir = path.join(workspace, ".agents", "skills", "broken");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "SKILL.md"), "---\ndescription: missing name\n---\nbody\n", "utf8");

    const outcome = listUcodeSkills({
      workspaceRoot: workspace,
      env: { HOME: home, CODEX_HOME: codexHome },
      repoRoot,
    });

    expect(outcome.skills).toEqual([]);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].message).toContain("name");
  });

  test("rendered skills section lists metadata but not skill body", () => {
    const workspace = path.join(tmp, "workspace");
    writeSkill(path.join(workspace, ".agents", "skills"), "demo", {
      name: "demo",
      description: "Demo workflow",
      body: "SECRET BODY",
    });
    const outcome = listUcodeSkills({
      workspaceRoot: workspace,
      env: { HOME: home, CODEX_HOME: codexHome },
      repoRoot,
    });

    const rendered = renderSkillsSection(outcome.skills);

    expect(rendered).toContain("## Skills");
    expect(rendered).toContain("demo");
    expect(rendered).toContain("Demo workflow");
    expect(rendered).not.toContain("SECRET BODY");
  });

  test("explicit skill mention injects one full skill block", () => {
    const workspace = path.join(tmp, "workspace");
    writeSkill(path.join(workspace, ".agents", "skills"), "demo", {
      name: "demo",
      description: "Demo workflow",
      body: "Demo body",
    });
    const outcome = listUcodeSkills({
      workspaceRoot: workspace,
      env: { HOME: home, CODEX_HOME: codexHome },
      repoRoot,
    });

    const injected = buildSkillInjections({
      prompt: "use $demo to inspect this",
      workspaceRoot: workspace,
      skillsOutcome: outcome,
    });

    expect(injected.warnings).toEqual([]);
    expect(injected.blocks).toHaveLength(1);
    expect(injected.blocks[0]).toContain("<skill>");
    expect(injected.blocks[0]).toContain("<name>demo</name>");
    expect(injected.blocks[0]).toContain("Demo body");
  });

  test("ambiguous name does not auto-inject, but explicit path link resolves", () => {
    const workspace = path.join(tmp, "workspace");
    const first = writeSkill(path.join(workspace, ".agents", "skills"), "a", {
      name: "demo",
      description: "First demo",
      body: "First body",
    });
    writeSkill(path.join(workspace, ".codex", "skills"), "b", {
      name: "demo",
      description: "Second demo",
      body: "Second body",
    });
    const outcome = listUcodeSkills({
      workspaceRoot: workspace,
      env: { HOME: home, CODEX_HOME: codexHome },
      repoRoot,
    });

    const ambiguous = buildSkillInjections({
      prompt: "use $demo",
      workspaceRoot: workspace,
      skillsOutcome: outcome,
    });
    expect(ambiguous.blocks).toEqual([]);
    expect(ambiguous.warnings.some((warning) => warning.includes("ambiguous"))).toBe(true);

    const linked = buildSkillInjections({
      prompt: `use [demo](${first}) and $demo`,
      workspaceRoot: workspace,
      skillsOutcome: outcome,
    });
    expect(linked.blocks).toHaveLength(1);
    expect(linked.blocks[0]).toContain("First body");
  });
});
