const fs = require("fs");
const os = require("os");
const path = require("path");

const { runUcodeCoreCli } = require("../../../src/code/cli");

function writeSkill(workspace, name = "demo") {
  const dir = path.join(workspace, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n\n${name} body\n`, "utf8");
}

describe("ucode-core skills cli", () => {
  let tmp;
  let oldHome;
  let oldCodexHome;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-cli-"));
    oldHome = process.env.HOME;
    oldCodexHome = process.env.CODEX_HOME;
    process.env.HOME = path.join(tmp, "home");
    process.env.CODEX_HOME = path.join(tmp, "codex-home");
    fs.mkdirSync(process.env.HOME, { recursive: true });
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("skills list returns discovered workspace skills as json", async () => {
    const workspace = path.join(tmp, "workspace");
    writeSkill(workspace, "demo");

    const result = await runUcodeCoreCli({
      argv: ["skills", "list", "--workspace", workspace, "--json"],
      projectRoot: workspace,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    expect(parsed.skills.some((skill) => skill.name === "demo" && skill.description === "demo description")).toBe(true);
  });

  test("skills show prints skill content", async () => {
    const workspace = path.join(tmp, "workspace");
    writeSkill(workspace, "demo");

    const result = await runUcodeCoreCli({
      argv: ["skills", "show", "demo", "--workspace", workspace],
      projectRoot: workspace,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("# demo");
    expect(result.output).toContain("demo body");
  });
});
