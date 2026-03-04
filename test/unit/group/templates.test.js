const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  TEMPLATE_SOURCE,
  createTemplateFromBuiltin,
  loadTemplateRegistry,
  resolveTemplateReference,
} = require("../../../src/group/templates");

const TEST_ROOT = path.join(os.tmpdir(), "ufoo-group-templates-test");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function buildTemplate(alias, name = alias) {
  return {
    schema_version: 1,
    template: {
      id: alias,
      alias,
      name,
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

describe("group templates registry", () => {
  const projectRoot = path.join(TEST_ROOT, "project");
  const builtinDir = path.join(TEST_ROOT, "builtin");
  const globalDir = path.join(TEST_ROOT, "global");
  const projectDir = path.join(projectRoot, ".ufoo", "templates", "groups");

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("uses project > global > builtin priority for same alias", () => {
    writeJson(path.join(builtinDir, "dev-basic.json"), buildTemplate("dev-basic", "builtin"));
    writeJson(path.join(globalDir, "dev-basic.json"), buildTemplate("dev-basic", "global"));
    writeJson(path.join(projectDir, "dev-basic.json"), buildTemplate("dev-basic", "project"));

    const registry = loadTemplateRegistry(projectRoot, { builtinDir, globalDir, projectDir });
    expect(registry.templates).toHaveLength(1);
    expect(registry.templates[0].source).toBe(TEMPLATE_SOURCE.PROJECT);
    expect(registry.templates[0].templateName).toBe("project");
  });

  test("resolveTemplateReference supports alias and direct path", () => {
    writeJson(path.join(builtinDir, "dev-basic.json"), buildTemplate("dev-basic"));
    writeJson(path.join(projectDir, "custom.json"), buildTemplate("custom"));

    const byAlias = resolveTemplateReference(projectRoot, "dev-basic", {
      builtinDir,
      globalDir,
      projectDir,
      cwd: projectRoot,
    });
    expect(byAlias.entry).toBeTruthy();
    expect(byAlias.entry.alias).toBe("dev-basic");

    const customPath = path.join(projectDir, "custom.json");
    const byPath = resolveTemplateReference(projectRoot, customPath, {
      builtinDir,
      globalDir,
      projectDir,
      cwd: projectRoot,
    });
    expect(byPath.entry).toBeTruthy();
    expect(byPath.entry.alias).toBe("custom");
  });

  test("createTemplateFromBuiltin writes project template with new alias", () => {
    writeJson(path.join(builtinDir, "dev-basic.json"), buildTemplate("dev-basic", "Dev Basic"));
    const created = createTemplateFromBuiltin(projectRoot, "team-alpha", "dev-basic", {
      builtinDir,
      globalDir,
      projectDir,
    });

    expect(created.alias).toBe("team-alpha");
    expect(created.scope).toBe("project");
    expect(fs.existsSync(created.filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(created.filePath, "utf8"));
    expect(saved.template.alias).toBe("team-alpha");
    expect(saved.template.name).toBe("Dev Basic");
  });

  test("createTemplateFromBuiltin surfaces builtin loader diagnostics", () => {
    const brokenBuiltin = path.join(builtinDir, "dev-basic.json");
    fs.mkdirSync(path.dirname(brokenBuiltin), { recursive: true });
    fs.writeFileSync(brokenBuiltin, "{\"schema_version\":1,\"template\":", "utf8");

    expect(() => createTemplateFromBuiltin(projectRoot, "team-alpha", "dev-basic", {
      builtinDir,
      globalDir,
      projectDir,
    })).toThrow("invalid JSON");
  });
});
