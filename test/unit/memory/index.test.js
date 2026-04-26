const fs = require("fs");
const os = require("os");
const path = require("path");

const MemoryManager = require("../../../src/memory");
const { buildCachedMemoryPrefix } = require("../../../src/memory");

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
    expect(manager.indexFile).toBe(path.join(canonicalRoot, ".ufoo", "memory", "INDEX.md"));
    expect(manager.auditFile).toBe(path.join(canonicalRoot, ".ufoo", "memory", "audit.jsonl"));
    expect(fs.existsSync(manager.memoryDir)).toBe(true);
  });

  test("adds markdown entries, index rows, and audit rows", () => {
    const manager = new MemoryManager(projectRoot);

    const entry = manager.add({
      title: "All user ids use UUID v7",
      body: "All user identifiers in this project must use UUID v7 across services.",
      tags: ["arch", "ids"],
      source: "user",
    });

    expect(entry).toEqual(expect.objectContaining({
      id: "mem-0001",
      title: "All user ids use UUID v7",
      tags: ["arch", "ids"],
      status: "active",
    }));
    expect(fs.existsSync(path.join(manager.memoryDir, "mem-0001.md"))).toBe(true);
    expect(fs.readFileSync(manager.indexFile, "utf8")).toContain(
      "- mem-0001 [arch,ids] All user ids use UUID v7"
    );
    expect(manager.readAudit("mem-0001")).toHaveLength(1);
  });

  test("lists, recalls, and searches active entries", () => {
    const manager = new MemoryManager(projectRoot);
    manager.add({
      title: "Stripe account ownership",
      body: "Production Stripe account is owned by the founder account.",
      tags: ["billing"],
    });
    manager.add({
      title: "User id invariant",
      body: "All user identifiers in this project must use UUID v7.",
      tags: ["arch"],
    });

    expect(manager.list({ tag: "arch" }).map((entry) => entry.id)).toEqual(["mem-0002"]);
    expect(manager.get("mem-0001").title).toBe("Stripe account ownership");
    expect(manager.search("uuid")).toEqual([
      expect.objectContaining({ id: "mem-0002" }),
    ]);
    expect(manager.buildPrefix()).toContain("## Project Memory");
    expect(manager.buildPrefix()).toContain("mem-0002 [arch] User id invariant");
  });

  test("builds prefix from INDEX summaries before opening entry bodies", () => {
    const manager = new MemoryManager(projectRoot);
    manager.add({
      title: "Canonical queue policy",
      body: "Background workers use exactly-once queue semantics for paid jobs.",
      tags: ["queue"],
    });
    fs.rmSync(path.join(manager.memoryDir, "mem-0001.md"), { force: true });

    expect(manager.buildPrefix()).toContain("mem-0001 [queue] Canonical queue policy");
  });

  test("caps prefix output and reports cache segment metadata", () => {
    const manager = new MemoryManager(projectRoot);
    manager.add({
      title: "First long memory title that should fit",
      body: "First durable fact body for prefix truncation verification.",
      tags: ["prefix"],
    });
    manager.add({
      title: "Second long memory title that should be truncated by token budget",
      body: "Second durable fact body for prefix truncation verification.",
      tags: ["prefix"],
    });

    const result = manager.buildPrefixResult({ maxTokens: 20 });
    expect(result.estimated_tokens).toBeLessThanOrEqual(20);
    expect(result.truncated).toBe(true);

    const first = buildCachedMemoryPrefix(projectRoot, { maxTokens: 200 });
    const second = buildCachedMemoryPrefix(projectRoot, { maxTokens: 200 });
    expect(first.cache_hit).toBe(false);
    expect(first.cache_semistatic_miss).toBeGreaterThan(0);
    expect(second.cache_hit).toBe(true);
    expect(second.cache_semistatic_hit).toBeGreaterThan(0);
  });

  test("updates entries with conflict detection", () => {
    const manager = new MemoryManager(projectRoot);
    const entry = manager.add({
      title: "DBA vacuum window",
      body: "DBA runs vacuum every Tuesday, avoid heavy migrations in that window.",
      tags: ["ops"],
    });

    const updated = manager.update(entry.id, {
      body: "DBA runs vacuum every Tuesday, avoid heavy migrations during that window.",
      expected_updated_at: entry.updated_at,
    });

    expect(updated.body).toContain("during that window");
    expect(() => manager.update(entry.id, {
      body: "This should conflict because it uses the original timestamp.",
      expected_updated_at: entry.updated_at,
    })).toThrow(expect.objectContaining({ code: "memory_conflict" }));
  });

  test("archives entries and excludes them from default list", () => {
    const manager = new MemoryManager(projectRoot);
    const entry = manager.add({
      title: "Export limit",
      body: "Free users may export data up to three times per month.",
      tags: ["product"],
    });

    const archived = manager.archive(entry.id);

    expect(archived.status).toBe("archived");
    expect(fs.existsSync(path.join(manager.archiveDir, "mem-0001.md"))).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.list({ includeArchived: true })).toHaveLength(1);
    expect(fs.readFileSync(manager.indexFile, "utf8")).not.toContain("mem-0001");
  });

  test("summarizes write frequency for memory observability", () => {
    const manager = new MemoryManager(projectRoot);
    for (let i = 0; i < 6; i += 1) {
      manager.add({
        title: `Observable write ${i}`,
        body: `Observable durable memory body number ${i} for write frequency accounting.`,
      }, {
        source: "tool",
        actor: "codex:busy",
      });
    }

    const summary = manager.readObservabilitySummary();
    expect(summary.actors[0]).toEqual(expect.objectContaining({
      actor: "codex:busy",
      writes: 6,
      warning: true,
    }));
  });

  test("keeps memory paths isolated per project root", () => {
    const otherProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-memory-"));

    try {
      const firstManager = new MemoryManager(projectRoot);
      const secondManager = new MemoryManager(otherProjectRoot);

      firstManager.add({
        title: "First project fact",
        body: "This fact belongs only to the first temporary project root.",
      });

      expect(firstManager.list()).toHaveLength(1);
      expect(secondManager.list()).toHaveLength(0);
      expect(secondManager.indexFile).not.toBe(firstManager.indexFile);
    } finally {
      fs.rmSync(otherProjectRoot, { recursive: true, force: true });
    }
  });
});
