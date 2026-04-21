const fs = require("fs");
const os = require("os");
const path = require("path");

const MemoryManager = require("../../../src/memory");

describe("MemoryManager", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-memory-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("requires an explicit project root", () => {
    expect(() => new MemoryManager()).toThrow("projectRoot is required");
  });

  test("stores memory under the canonical project root", () => {
    const nestedLink = path.join(projectRoot, "..", path.basename(projectRoot));
    const canonicalRoot = fs.realpathSync(projectRoot);
    const manager = new MemoryManager(nestedLink);

    expect(manager.projectRoot).toBe(canonicalRoot);
    expect(manager.memoryDir).toBe(path.join(canonicalRoot, ".ufoo", "memory"));
    expect(manager.memoryFile).toBe(
      path.join(canonicalRoot, ".ufoo", "memory", "memory.jsonl")
    );
    expect(fs.existsSync(manager.memoryDir)).toBe(true);
  });

  test("keeps memory paths isolated per project root", () => {
    const otherProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-memory-"));

    try {
      const firstManager = new MemoryManager(projectRoot);
      const secondManager = new MemoryManager(otherProjectRoot);
      const canonicalFirstRoot = fs.realpathSync(projectRoot);
      const canonicalSecondRoot = fs.realpathSync(otherProjectRoot);

      firstManager.addEntry({ type: "note", content: "first-project" });

      expect(firstManager.memoryFile).toBe(
        path.join(canonicalFirstRoot, ".ufoo", "memory", "memory.jsonl")
      );
      expect(secondManager.memoryFile).toBe(
        path.join(canonicalSecondRoot, ".ufoo", "memory", "memory.jsonl")
      );
      expect(secondManager.memoryFile).not.toBe(firstManager.memoryFile);
      expect(fs.existsSync(firstManager.memoryFile)).toBe(true);
      expect(fs.existsSync(secondManager.memoryFile)).toBe(false);
    } finally {
      fs.rmSync(otherProjectRoot, { recursive: true, force: true });
    }
  });

  test("appends entries to memory jsonl", () => {
    const manager = new MemoryManager(projectRoot);

    manager.addEntry({ type: "note", content: "first" });
    manager.addEntry({ type: "note", content: "second", tags: ["x"] });

    const lines = fs
      .readFileSync(manager.memoryFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(
      expect.objectContaining({
        type: "note",
        content: "first",
      })
    );
    expect(lines[1]).toEqual(
      expect.objectContaining({
        type: "note",
        content: "second",
        tags: ["x"],
      })
    );
    expect(typeof lines[0].timestamp).toBe("string");
    expect(typeof lines[1].timestamp).toBe("string");
  });
});
