const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const UFOO_BIN = path.join(REPO_ROOT, "bin", "ufoo.js");

function runCli(args = []) {
  return spawnSync(process.execPath, [UFOO_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("bin group command contracts", () => {
  test("supports commander syntax: ufoo group templates list", () => {
    const result = runCli(["group", "templates", "list"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("- build-lane [builtin]");
  });

  test("template validate path surfaces invalid JSON diagnostics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-bin-group-"));
    const brokenPath = path.join(dir, "broken.json");
    fs.writeFileSync(brokenPath, "{\"schema_version\":1,\"template\":", "utf8");

    const result = runCli(["group", "template", "validate", brokenPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid JSON");
    expect(result.stderr).not.toContain("Template not found");
  });
});
