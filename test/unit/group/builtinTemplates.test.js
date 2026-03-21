const path = require("path");
const { loadTemplateRegistry } = require("../../../src/group/templates");
const { validateTemplateEntry } = require("../../../src/group/templateValidation");

describe("builtin group templates", () => {
  test("repo builtin templates validate with the prompt profile registry", () => {
    const projectRoot = path.join(__dirname, "..", "..", "..");
    const registry = loadTemplateRegistry(projectRoot, {
      builtinDir: path.join(projectRoot, "templates", "groups"),
      globalDir: path.join(projectRoot, ".tmp-no-global-templates"),
      projectDir: path.join(projectRoot, ".tmp-no-project-templates"),
    });
    const aliases = registry.templates.map((item) => item.alias);

    expect(aliases).toEqual(
      expect.arrayContaining([
        "product-discovery",
        "build-lane",
        "verify-ship",
        "ui-polish",
      ])
    );

    for (const entry of registry.templates) {
      const result = validateTemplateEntry(projectRoot, entry, {
        promptProfilesOptions: {
          globalDir: path.join(projectRoot, ".tmp-no-global-profiles"),
          projectDir: path.join(projectRoot, ".tmp-no-project-profiles"),
        },
      });
      expect(result.ok).toBe(true);
    }
  });
});
