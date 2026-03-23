const fs = require("fs");
const os = require("os");
const path = require("path");

const ContextDoctor = require("../../../src/context/doctor");

describe("ContextDoctor", () => {
  let projectRoot;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-doctor-"));
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("constructor", () => {
    test("sets projectRoot and contextDir", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.projectRoot).toBe(projectRoot);
      expect(doctor.contextDir).toBe(
        path.join(projectRoot, ".ufoo", "context")
      );
      expect(doctor.failed).toBe(false);
    });
  });

  describe("fail", () => {
    test("logs error and sets failed flag", () => {
      const doctor = new ContextDoctor(projectRoot);
      doctor.fail("something broke");
      expect(doctor.failed).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalledWith("FAIL: something broke");
    });
  });

  describe("checkFile", () => {
    test("returns true for existing file", () => {
      const file = path.join(projectRoot, "test.txt");
      fs.writeFileSync(file, "hello");
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.checkFile(file)).toBe(true);
      expect(doctor.failed).toBe(false);
    });

    test("returns false and fails for missing file", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.checkFile("/nonexistent/file.txt", "myfile")).toBe(false);
      expect(doctor.failed).toBe(true);
    });

    test("uses filePath as name when name is not provided", () => {
      const doctor = new ContextDoctor(projectRoot);
      doctor.checkFile("/nonexistent/file.txt");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "FAIL: Missing file: /nonexistent/file.txt"
      );
    });
  });

  describe("checkDir", () => {
    test("returns true for existing directory", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.checkDir(projectRoot)).toBe(true);
      expect(doctor.failed).toBe(false);
    });

    test("returns false and fails for missing directory", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.checkDir("/nonexistent/dir", "mydir")).toBe(false);
      expect(doctor.failed).toBe(true);
    });

    test("uses dirPath as name when name is not provided", () => {
      const doctor = new ContextDoctor(projectRoot);
      doctor.checkDir("/nonexistent/dir");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "FAIL: Missing directory: /nonexistent/dir"
      );
    });
  });

  describe("checkAnyGlob", () => {
    test("returns true when files match pattern", () => {
      fs.writeFileSync(path.join(projectRoot, "foo.md"), "content");
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.checkAnyGlob(projectRoot, /\.md$/, "markdown files")).toBe(
        true
      );
    });

    test("returns false when no files match pattern", () => {
      fs.writeFileSync(path.join(projectRoot, "foo.txt"), "content");
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.checkAnyGlob(projectRoot, /\.md$/, "markdown files")).toBe(
        false
      );
      expect(doctor.failed).toBe(true);
    });

    test("returns false when directory does not exist", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(
        doctor.checkAnyGlob("/nonexistent/dir", /\.md$/, "markdown files")
      ).toBe(false);
      expect(doctor.failed).toBe(true);
    });
  });

  describe("lintProject", () => {
    test("succeeds with valid context structure", () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.writeFileSync(path.join(ctxDir, "decisions.jsonl"), "");

      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.lintProject()).toBe(true);
    });

    test("fails when context directory is missing", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.lintProject()).toBe(false);
    });

    test("accepts custom projectPath", () => {
      const customCtx = path.join(projectRoot, "custom-ctx");
      const decisionsDir = path.join(customCtx, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.writeFileSync(path.join(customCtx, "decisions.jsonl"), "");

      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.lintProject(customCtx)).toBe(true);
    });
  });

  describe("lintProtocol", () => {
    test("returns true when no protocol module exists", () => {
      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.lintProtocol()).toBe(true);
    });

    test("succeeds with valid protocol structure", () => {
      const moduleRoot = path.join(projectRoot, "modules", "context");
      const skillDir = path.join(moduleRoot, "SKILLS", "uctx");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(moduleRoot, "README.md"), "# Context");
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill");

      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.lintProtocol()).toBe(true);
    });

    test("fails when protocol files are missing", () => {
      const moduleRoot = path.join(projectRoot, "modules", "context");
      fs.mkdirSync(moduleRoot, { recursive: true });

      const doctor = new ContextDoctor(projectRoot);
      expect(doctor.lintProtocol()).toBe(false);
    });
  });

  describe("run", () => {
    test("runs in protocol mode by default", async () => {
      const doctor = new ContextDoctor(projectRoot);
      const result = await doctor.run();
      // No protocol module, so lintProtocol returns true (skipped)
      expect(result).toBe(true);
    });

    test("runs in project mode with valid context", async () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      const decisionsDir = path.join(ctxDir, "decisions");
      fs.mkdirSync(decisionsDir, { recursive: true });
      fs.writeFileSync(path.join(ctxDir, "decisions.jsonl"), "");

      const doctor = new ContextDoctor(projectRoot);
      const result = await doctor.run({
        mode: "project",
        projectPath: ctxDir,
      });
      expect(result).toBe(true);
    });

    test("fails in project mode without projectPath", async () => {
      const doctor = new ContextDoctor(projectRoot);
      const result = await doctor.run({ mode: "project" });
      expect(result).toBe(false);
    });

    test("handles decisions check failure in project mode", async () => {
      const ctxDir = path.join(projectRoot, ".ufoo", "context");
      fs.mkdirSync(ctxDir, { recursive: true });
      // No decisions.jsonl, no decisions dir - will fail lint but still tries decisions check
      const doctor = new ContextDoctor(projectRoot);
      const result = await doctor.run({
        mode: "project",
        projectPath: ctxDir,
      });
      expect(result).toBe(false);
    });

    test("resets failed state between runs", async () => {
      const doctor = new ContextDoctor(projectRoot);
      doctor.failed = true;
      await doctor.run(); // protocol mode, no module => OK
      expect(doctor.failed).toBe(false);
    });
  });
});
