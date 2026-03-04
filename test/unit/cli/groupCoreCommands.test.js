const fs = require("fs");
const path = require("path");
const os = require("os");
const { runGroupCoreCommand } = require("../../../src/cli/groupCoreCommands");

const TEST_ROOT = path.join(os.tmpdir(), "ufoo-group-core-commands-test");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sampleTemplate(alias) {
  return {
    schema_version: 1,
    template: {
      id: alias,
      alias,
      name: alias,
    },
    agents: [
      {
        id: "solo",
        nickname: "solo",
        type: "codex",
        startup_order: 1,
        depends_on: [],
        accept_from: [],
        report_to: [],
      },
    ],
    edges: [],
  };
}

describe("cli groupCoreCommands", () => {
  const projectRoot = path.join(TEST_ROOT, "project");
  const builtinDir = path.join(TEST_ROOT, "builtin");
  const globalDir = path.join(TEST_ROOT, "global");
  const projectDir = path.join(projectRoot, ".ufoo", "templates", "groups");

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    writeJson(path.join(builtinDir, "dev-basic.json"), sampleTemplate("dev-basic"));
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("templates list prints available aliases", async () => {
    const logs = [];
    await runGroupCoreCommand("templates", ["list"], {
      cwd: projectRoot,
      write: (line) => logs.push(String(line)),
      templatesOptions: { builtinDir, globalDir, projectDir },
    });
    expect(logs.some((line) => line.includes("dev-basic"))).toBe(true);
  });

  test("templates ls alias is accepted", async () => {
    const logs = [];
    await runGroupCoreCommand("templates", ["ls"], {
      cwd: projectRoot,
      write: (line) => logs.push(String(line)),
      templatesOptions: { builtinDir, globalDir, projectDir },
    });
    expect(logs.some((line) => line.includes("dev-basic"))).toBe(true);
  });

  test("template validate throws when template is invalid", async () => {
    const invalidPath = path.join(projectRoot, "invalid-template.json");
    writeJson(invalidPath, { schema_version: 1, template: { alias: "bad" }, agents: [], edges: [] });

    await expect(
      runGroupCoreCommand("template", ["validate", invalidPath], {
        cwd: projectRoot,
        write: () => {},
        templatesOptions: { builtinDir, globalDir, projectDir },
      })
    ).rejects.toThrow("Template validation failed");
  });

  test("template validate reports invalid JSON parse errors for path input", async () => {
    const brokenPath = path.join(projectRoot, "broken.json");
    fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
    fs.writeFileSync(brokenPath, "{not-json\n", "utf8");

    await expect(
      runGroupCoreCommand("template", ["validate", brokenPath], {
        cwd: projectRoot,
        write: () => {},
        templatesOptions: { builtinDir, globalDir, projectDir },
      })
    ).rejects.toThrow("invalid JSON");
  });

  test("template show prints JSON payload for existing alias", async () => {
    const logs = [];
    await runGroupCoreCommand("template", ["show", "dev-basic"], {
      cwd: projectRoot,
      write: (line) => logs.push(String(line)),
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const rendered = logs.join("\n");
    expect(rendered).toContain("\"alias\": \"dev-basic\"");
    expect(rendered).toContain("\"agents\"");
  });

  test("template new creates a project template from builtin", async () => {
    const logs = [];
    await runGroupCoreCommand("template", ["new", "team-alpha", "--from", "dev-basic"], {
      cwd: projectRoot,
      write: (line) => logs.push(String(line)),
      templatesOptions: { builtinDir, globalDir, projectDir },
    });

    const createdPath = path.join(projectDir, "team-alpha.json");
    expect(fs.existsSync(createdPath)).toBe(true);
    expect(logs.some((line) => line.includes("team-alpha"))).toBe(true);
  });

  test("template new rejects conflicting scope flags", async () => {
    await expect(
      runGroupCoreCommand("template", ["new", "team-alpha", "--from", "dev-basic", "--global", "--project"], {
        cwd: projectRoot,
        write: () => {},
        templatesOptions: { builtinDir, globalDir, projectDir },
      })
    ).rejects.toThrow("cannot use both --global and --project");
  });
});
