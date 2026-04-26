const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  BUILTIN_PROFILES,
  loadPromptProfileRegistry,
  resolvePromptProfileReference,
} = require("../../../src/group/promptProfiles");

const TEST_ROOT = path.join(os.tmpdir(), "ufoo-prompt-profiles-test");

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

describe("group prompt profile registry", () => {
  const projectRoot = path.join(TEST_ROOT, "project");
  const globalDir = path.join(TEST_ROOT, "global");
  const projectDir = path.join(projectRoot, ".ufoo", "prompt-profiles");

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("builtin aliases resolve legacy prompt_profile names", () => {
    const registry = loadPromptProfileRegistry(projectRoot, { globalDir, projectDir });

    expect(resolvePromptProfileReference(registry, "architecture-review")?.id).toBe("system-architect");
    expect(resolvePromptProfileReference(registry, "code-implement")?.id).toBe("implementation-lead");
    expect(resolvePromptProfileReference(registry, "design-critic")?.display_name).toBe("Design");
    expect(resolvePromptProfileReference(registry, "frontend-refiner")?.display_name).toBe("Polish");
    expect(resolvePromptProfileReference(registry, "design-consultation")?.id).toBe("design-system-consultant");
    expect(resolvePromptProfileReference(registry, "plan-design-review")?.id).toBe("ui-plan-critic");
    expect(resolvePromptProfileReference(registry, "task-breakdown")?.id).toBe("task-breakdown");
    expect(resolvePromptProfileReference(registry, "Architecture")).toBeNull();
  });

  test("higher-priority overrides replace the whole profile entry including aliases", () => {
    writeJson(path.join(projectDir, "system-architect.json"), {
      id: "system-architect",
      display_name: "Custom Architecture",
      aliases: ["arch-custom"],
      prompt: "custom architect prompt",
    });

    const registry = loadPromptProfileRegistry(projectRoot, { globalDir, projectDir });
    expect(resolvePromptProfileReference(registry, "system-architect")?.display_name).toBe("Custom Architecture");
    expect(resolvePromptProfileReference(registry, "arch-custom")?.id).toBe("system-architect");
    expect(resolvePromptProfileReference(registry, "architecture-review")).toBeNull();
  });

  test("lookup collisions fail registry load", () => {
    writeJson(path.join(projectDir, "custom-one.json"), {
      id: "custom-one",
      aliases: ["system-architect"],
      prompt: "one",
    });

    const registry = loadPromptProfileRegistry(projectRoot, { globalDir, projectDir });
    expect(registry.errors.some((item) => String(item.message).includes("conflicts"))).toBe(true);
  });

  test("builtin profile handoffs use runtime metadata instead of hard-coded profile targets", () => {
    const forbiddenTargets = [
      "review-critic",
      "qa-driver",
      "frontend-refiner",
      "design-critic",
      "debug-investigator",
      "implementation-lead",
    ];

    for (const profile of BUILTIN_PROFILES) {
      expect(profile.prompt).toContain("Runtime metadata");
      for (const target of forbiddenTargets) {
        expect(profile.prompt).not.toContain(target);
      }
    }
  });
});
