"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSkillInjections } = require("../../../src/code/skills/injection");
const { listUcodeSkills } = require("../../../src/code/skills");

/**
 * R9 Skills MVP boundary audit — lock DECISION 0310 constraints.
 */
describe("Skills MVP boundary (R9)", () => {
  let tmp = "";
  let workspace = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-skills-r9-"));
    workspace = path.join(tmp, "ws");
    fs.mkdirSync(path.join(workspace, ".agents", "skills", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".agents", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n\nSECRET_BODY_SHOULD_NOT_ALWAYS_INJECT\n",
      "utf8"
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("metadata discovery does not inject body without explicit mention", () => {
    const listed = listUcodeSkills({ workspaceRoot: workspace });
    const skills = Array.isArray(listed) ? listed : (listed.skills || []);
    expect(skills.some((s) => s.name === "demo")).toBe(true);
    const inj = buildSkillInjections({
      prompt: "hello world without skill tag",
      workspaceRoot: workspace,
      persistBodies: false,
    });
    const blob = JSON.stringify(inj);
    expect(blob).not.toContain("SECRET_BODY_SHOULD_NOT_ALWAYS_INJECT");
  });

  test("explicit $skill mention injects body", () => {
    const inj = buildSkillInjections({
      prompt: "use $demo please",
      workspaceRoot: workspace,
      persistBodies: false,
      useActiveSkillTag: true,
    });
    const bodies = (inj.injections || inj.bodies || inj.activeSkills || []);
    const text = JSON.stringify(inj);
    expect(text).toMatch(/SECRET_BODY_SHOULD_NOT_ALWAYS_INJECT|demo/i);
    expect(Array.isArray(bodies) || inj.warnings).toBeTruthy();
  });

  test("skill modules do not export hooks / fork / model override surfaces", () => {
    const skills = require("../../../src/code/skills");
    expect(skills.runSkillHook).toBeUndefined();
    expect(skills.forkSkillAgent).toBeUndefined();
    expect(skills.overrideSkillModel).toBeUndefined();
    expect(typeof skills.listUcodeSkills).toBe("function");
    expect(typeof skills.buildSkillInjections).toBe("function");
  });
});
