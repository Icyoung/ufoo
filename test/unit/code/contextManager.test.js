const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  saveArtifact,
  loadArtifact,
  readArtifactSlice,
} = require("../../../src/code/context/artifacts");
const {
  reduceToolResult,
} = require("../../../src/code/context/reducers");
const {
  appendTranscriptEvent,
  loadTranscript,
  migrateNlMessagesToTranscript,
} = require("../../../src/code/context/transcript");
const {
  assembleModelContext,
  buildRecentMessages,
  buildRollingSummary,
  persistToolResultToContext,
  recordToolCallInSession,
  ensureProjectSnapshot,
} = require("../../../src/code/context/assembler");
const {
  buildLayeredSystemPrompt,
  systemBlocksToAnthropicPayload,
} = require("../../../src/code/context/promptLayers");
const {
  buildProjectSnapshot,
  renderProjectSnapshotContext,
  isProjectSnapshotStale,
  invalidateProjectSnapshotIfPathTouched,
} = require("../../../src/code/context/projectSnapshot");
const {
  buildInitialTaskContract,
  applyStateCommit,
  parseStructuredSideEffects,
} = require("../../../src/code/context/stateCommit");
const {
  applyWorkingSetPlan,
} = require("../../../src/code/context/workingSet");
const {
  normalizeExecutionSegment,
  startExecutionSegment,
  executeExecutionSegment,
} = require("../../../src/code/context/executionSegment");
const {
  saveSessionSnapshot,
  loadSessionSnapshot,
} = require("../../../src/code/sessionStore");
const { runArtifactReadTool } = require("../../../src/code/tools/artifactRead");
describe("ucode context manager", () => {
  let workspaceRoot = "";

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-ctx-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("artifact store saves and reads slices", () => {
    const saved = saveArtifact(workspaceRoot, "sess-1", {
      artifactId: "artifact_test",
      tool: "read",
      raw: { ok: true, path: "a.txt", content: "line1\nline2\nline3" },
    });
    expect(saved.ok).toBe(true);
    const loaded = loadArtifact(workspaceRoot, "sess-1", "artifact_test");
    expect(loaded.ok).toBe(true);
    const slice = readArtifactSlice(loaded.artifact, { startLine: 2, endLine: 3 });
    expect(slice.content).toBe("line2\nline3");
  });

  test("reducers produce compact model payloads", () => {
    const reduced = reduceToolResult("bash", {
      ok: true,
      code: 1,
      stdout: "a\n".repeat(100),
      stderr: "err",
    }, "artifact_bash");
    expect(reduced.modelPayload.artifactId).toBe("artifact_bash");
    expect(reduced.modelPayload.exitCode).toBe(1);
    expect(reduced.preview).toContain("stdout");
  });

  test("transcript migration from nlMessages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const events = migrateNlMessagesToTranscript(workspaceRoot, "sess-migrate", messages);
    expect(events.length).toBe(2);
    const loaded = loadTranscript(workspaceRoot, "sess-migrate");
    expect(loaded.events.length).toBe(2);
  });

  test("assembler windows transcript for model input", () => {
    const session = {
      sessionId: "sess-window",
      workspaceRoot,
      nlMessages: [],
      transcriptEvents: [],
    };
    for (let i = 0; i < 20; i += 1) {
      appendTranscriptEvent(workspaceRoot, session.sessionId, {
        role: "user",
        content: `message ${i}`,
      });
    }
    session.transcriptEvents = loadTranscript(workspaceRoot, session.sessionId).events;
    const assembled = assembleModelContext(session, { workspaceRoot });
    expect(assembled.messages.length).toBeLessThanOrEqual(12);
    expect(assembled.summary).toContain("omitted");
  });

  test("layered prompt exposes cacheable blocks", () => {
    const layered = buildLayeredSystemPrompt({ workspaceRoot });
    expect(layered.blocks.length).toBeGreaterThanOrEqual(2);
    const anthropic = systemBlocksToAnthropicPayload(layered.blocks);
    expect(anthropic[0].cache_control).toEqual({ type: "ephemeral" });
    expect(anthropic[anthropic.length - 1].cache_control).toBeUndefined();
  });

  test("project snapshot stores artifact refs", () => {
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Rules\nUse tests.");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "demo", packageManager: "pnpm" }));
    const snapshot = buildProjectSnapshot({ workspaceRoot, sessionId: "sess-proj" });
    expect(snapshot.projectSnapshotId).toMatch(/^project_snapshot_/);
    expect(snapshot.files.length).toBeGreaterThan(0);
    const rendered = renderProjectSnapshotContext(snapshot);
    expect(rendered).toContain("artifact://");
  });

  test("state commit appends without replacing snapshot", () => {
    const epoch = applyStateCommit(null, {
      factsAdd: ["worker.rs handles commands"],
      nextObjective: "profile flush path",
    });
    expect(epoch.snapshot.facts).toContain("worker.rs handles commands");
    expect(epoch.commits.length).toBe(1);
  });

  test("working set plan is capped by runtime", () => {
    const plan = {
      retainRaw: Array.from({ length: 20 }, (_, i) => `artifact_${i}`),
    };
    const next = applyWorkingSetPlan([], plan, { sessionId: "s" });
    expect(next.length).toBeLessThanOrEqual(12);
  });

  test("execution segment normalizes steps", () => {
    const segment = normalizeExecutionSegment({
      type: "execution_segment",
      objective: "find config",
      steps: [{ tool: "bash", args: { command: "ls" } }],
      checkpoint: { after: ["s1"] },
    });
    expect(segment.steps[0].id).toBe("s1");
    const started = startExecutionSegment(null, segment);
    expect(started.segmentId).toMatch(/^seg_/);
  });

  test("session v2 save/load keeps transcript external", () => {
    migrateNlMessagesToTranscript(workspaceRoot, "sess-v2", [
      { role: "user", content: "hello" },
    ]);
    const saved = saveSessionSnapshot(workspaceRoot, {
      sessionId: "sess-v2",
      workspaceRoot,
      provider: "openai",
      model: "gpt-5",
      context: "rules",
      nlMessages: [{ role: "user", content: "hello" }],
      summary: "rolling",
    });
    expect(saved.ok).toBe(true);
    const raw = JSON.parse(fs.readFileSync(saved.filePath, "utf8"));
    expect(raw.version).toBe(2);
    expect(raw.nlMessages).toBeUndefined();
    const loaded = loadSessionSnapshot(workspaceRoot, "sess-v2");
    expect(loaded.ok).toBe(true);
    expect(loaded.snapshot.nlMessages).toEqual([{ role: "user", content: "hello" }]);
    expect(loaded.snapshot.summary).toBe("rolling");
  });

  test("artifact_read hydrates stored artifact", () => {
    saveArtifact(workspaceRoot, "sess-read", {
      artifactId: "artifact_raw",
      tool: "read",
      raw: { ok: true, content: "alpha\nbeta\ngamma", path: "x.txt" },
    });
    const result = runArtifactReadTool(
      { artifactId: "artifact_raw", startLine: 2, endLine: 2 },
      { workspaceRoot, sessionId: "sess-read" },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe("beta");
  });

  test("parseStructuredSideEffects extracts JSON commit", () => {
    const parsed = parseStructuredSideEffects('{"stateCommit":{"factsAdd":["x"],"nextObjective":"y"}}');
    expect(parsed.stateCommit.factsAdd).toEqual(["x"]);
  });

  test("parseStructuredSideEffects recovers JSON embedded in prose", () => {
    const text = [
      "Here is my plan before the commit:",
      'Looking good. {"stateCommit":{"factsAdd":["worker owns flush"],"nextObjective":"add tests"},"contextPlan":{"retainRaw":["artifact_a"]}}',
      "Thanks.",
    ].join("\n");
    const parsed = parseStructuredSideEffects(text);
    expect(parsed).not.toBeNull();
    expect(parsed.stateCommit.factsAdd).toEqual(["worker owns flush"]);
    expect(parsed.contextPlan.retainRaw).toEqual(["artifact_a"]);
  });

  test("buildRollingSummary includes epoch and execution signals", () => {
    const session = {
      taskContract: { objective: "Fix flush race" },
      stateEpoch: {
        snapshot: {
          currentObjective: "Add regression test",
          facts: ["worker.rs owns flush"],
          decisions: ["Use deterministic reducer"],
        },
      },
      executionState: {
        modifiedFiles: ["src/code/context/assembler.js"],
      },
    };
    const events = Array.from({ length: 15 }, (_, i) => ({
      role: "user",
      content: `goal line ${i}`,
    }));
    const summary = buildRollingSummary(events, "", session);
    expect(summary).toContain("Objective: Fix flush race");
    expect(summary).toContain("Facts:");
    expect(summary).toContain("Modified files:");
    expect(summary).toContain("Earlier transcript");
  });

  test("project snapshot rebuilds when preflight files change", () => {
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Rules\nv1");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "demo" }));
    const first = buildProjectSnapshot({ workspaceRoot, sessionId: "sess-stale" });
    expect(isProjectSnapshotStale(first, workspaceRoot)).toBe(false);

    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Rules\nv2 changed");
    expect(isProjectSnapshotStale(first, workspaceRoot)).toBe(true);

    const session = { sessionId: "sess-stale", projectSnapshot: first };
    const refreshed = ensureProjectSnapshot(session, workspaceRoot);
    expect(refreshed.projectSnapshotId).not.toBe(first.projectSnapshotId);
    expect(isProjectSnapshotStale(refreshed, workspaceRoot)).toBe(false);
  });

  test("write/edit of preflight file invalidates project snapshot", () => {
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Rules\nv1");
    const snapshot = buildProjectSnapshot({ workspaceRoot, sessionId: "sess-inv" });
    const session = {
      sessionId: "sess-inv",
      projectSnapshot: snapshot,
      executionState: { modifiedFiles: [], lastExitCodes: [], retries: {} },
      toolCallsSinceCommit: 0,
      workingSet: [],
    };
    expect(invalidateProjectSnapshotIfPathTouched(session, "src/code/foo.js")).toBe(false);
    expect(session.projectSnapshot).toBe(snapshot);

    recordToolCallInSession(session, {
      tool: "write",
      args: { path: "AGENTS.md" },
      modelPayload: { ok: true },
      preview: "wrote AGENTS.md",
    }, workspaceRoot);
    expect(session.projectSnapshot).toBeNull();
    expect(session.executionState.modifiedFiles).toContain("AGENTS.md");
  });

  test("transcript storage keeps artifact refs for tool messages", () => {
    const { appendTranscriptMessagesForStorage, messageToTranscriptEventForStorage } = require("../../../src/code/context/transcriptSync");
    const event = messageToTranscriptEventForStorage({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ artifactId: "artifact_abc", preview: "short preview" }),
    });
    expect(event.artifactId).toBe("artifact_abc");
    expect(event.rawMessage).toBeUndefined();
    appendTranscriptMessagesForStorage(workspaceRoot, "sess-tx", [{
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ artifactId: "artifact_abc", preview: "short preview" }),
    }]);
    const loaded = loadTranscript(workspaceRoot, "sess-tx");
    expect(loaded.events[0].artifactId).toBe("artifact_abc");
    expect(loaded.events[0].rawMessage).toBeUndefined();
  });

  test("assembler filters tool events outside working set", () => {
    const events = [
      { role: "user", content: "old" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_old_0", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", artifactId: "artifact_old_0", preview: "p0", toolCallId: "call_old_0" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_old_2", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", artifactId: "artifact_old_2", preview: "p2", toolCallId: "call_old_2" },
    ];
    // Push older tools out of the recent-tool window (default 4).
    for (let i = 0; i < 5; i += 1) {
      events.push({
        role: "assistant",
        content: null,
        toolCalls: [{ id: `call_mid_${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
      });
      events.push({
        role: "tool",
        artifactId: `artifact_mid_${i}`,
        preview: `mid${i}`,
        toolCallId: `call_mid_${i}`,
      });
    }
    events.push({ role: "user", content: "latest question" });
    events.push({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call_recent", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    events.push({ role: "tool", artifactId: "artifact_recent", preview: "recent", toolCallId: "call_recent" });

    const session = {
      workingSet: [{ artifactId: "artifact_old_2", priority: 0.9 }],
    };
    const { buildModelMessagesFromTranscript } = require("../../../src/code/context/assembler");
    const messages = buildModelMessagesFromTranscript(events, session, 20);
    const toolBodies = messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    expect(toolBodies).toContain("artifact_recent");
    expect(toolBodies).toContain("artifact_old_2");
    expect(toolBodies).not.toContain("artifact_old_0");
  });

  test("assembler never emits assistant tool_calls without tool outputs", () => {
    const { buildModelMessagesFromTranscript, sanitizeModelMessages } = require("../../../src/code/context/assembler");
    const events = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_ZWpQa6evFzuI94xiYoO9dsky", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      // Intentionally omit tool result from the selected window by putting an
      // unrelated large history ahead and excluding this artifact from working set.
      { role: "tool", artifactId: "artifact_hidden", preview: "hidden", toolCallId: "call_ZWpQa6evFzuI94xiYoO9dsky" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ];
    // Empty working set + force window that keeps assistant tool_calls but would
    // drop the old tool row without repair.
    const messages = buildModelMessagesFromTranscript(events, { workingSet: [] }, 3);
    const broken = messages.some((message, index) => {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return false;
      const ids = message.tool_calls.map((c) => c.id);
      const following = [];
      for (let j = index + 1; j < messages.length; j += 1) {
        if (messages[j].role !== "tool") break;
        following.push(messages[j].tool_call_id);
      }
      return !ids.every((id) => following.includes(id));
    });
    expect(broken).toBe(false);

    const sanitized = sanitizeModelMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_orphan", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "user", content: "oops" },
    ]);
    expect(sanitized.some((m) => m.role === "assistant" && m.tool_calls)).toBe(false);
  });

  test("ensureToolCallPairs force-includes filtered tool results", () => {
    const { ensureToolCallPairs } = require("../../../src/code/context/assembler");
    const all = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", toolCallId: "call_1", artifactId: "artifact_1", preview: "ok" },
      { role: "assistant", content: "done" },
    ];
    const selected = [all[0], all[1], all[3]]; // missing tool on purpose
    const paired = ensureToolCallPairs(selected, all);
    expect(paired.some((e) => e.toolCallId === "call_1")).toBe(true);
    expect(paired.some((e) => e.role === "assistant" && e.toolCalls)).toBe(true);
  });

  test("deterministic state commit after tool interval", () => {
    const { recordToolCallInSession } = require("../../../src/code/context/assembler");
    const session = {
      sessionId: "sess-commit",
      workspaceRoot,
      toolCallsSinceCommit: 0,
      stateEpoch: null,
      workingSet: [],
      executionState: { modifiedFiles: [], currentSegmentId: "", mode: "single_action", steps: {}, segments: [], approvals: [], retries: {} },
    };
    process.env.UFOO_UCODE_COMMIT_INTERVAL = "2";
    recordToolCallInSession(session, {
      tool: "read",
      artifactId: "artifact_read_1",
      preview: "read package.json",
      args: { path: "package.json" },
    }, workspaceRoot);
    expect(session.toolCallsSinceCommit).toBe(1);
    recordToolCallInSession(session, {
      tool: "bash",
      artifactId: "artifact_bash_1",
      preview: "bash exit=0",
      args: { command: "npm test" },
    }, workspaceRoot);
    expect(session.toolCallsSinceCommit).toBe(0);
    expect(session.stateEpoch.commits.length).toBeGreaterThan(0);
    delete process.env.UFOO_UCODE_COMMIT_INTERVAL;
  });

  test("bash test reducer extracts pass fail counts", () => {
    const reduced = reduceToolResult("bash", {
      ok: false,
      code: 1,
      stdout: "Tests: 2 failed, 10 passed\n● should handle null\nFAIL src/foo.test.js",
      stderr: "",
    }, "artifact_test", { command: "npm test" });
    expect(reduced.modelPayload.failed).toBe(2);
    expect(reduced.modelPayload.passed).toBe(10);
    expect(reduced.modelPayload.kind).toBe("test");
    expect(reduced.modelPayload.failures.length).toBeGreaterThan(0);
  });

  test("git diff reducer extracts changed files", () => {
    const reduced = reduceToolResult("bash", {
      ok: true,
      code: 0,
      stdout: "diff --git a/src/a.js b/src/a.js\nindex 111..222\n--- a/src/a.js\n+++ b/src/a.js\ndiff --git a/src/b.js b/src/b.js\n",
      stderr: "",
    }, "artifact_diff", { command: "git diff" });
    expect(reduced.modelPayload.kind).toBe("git_diff");
    expect(reduced.modelPayload.files).toEqual(expect.arrayContaining(["src/a.js", "src/b.js"]));
  });

  test("search reducer extracts path:line matches", () => {
    const reduced = reduceToolResult("bash", {
      ok: true,
      code: 0,
      stdout: "src/a.js:10: foo()\nsrc/b.js:22: bar()\n",
      stderr: "",
    }, "artifact_rg", { command: "rg foo" });
    expect(reduced.modelPayload.kind).toBe("search");
    expect(reduced.modelPayload.matches[0].path).toBe("src/a.js");
    expect(reduced.modelPayload.matches[0].line).toBe(10);
  });

  test("artifact index extracts symbols for read results", () => {
    const saved = saveArtifact(workspaceRoot, "sess-index", {
      tool: "read",
      args: { path: "demo.js" },
      raw: {
        ok: true,
        path: "demo.js",
        content: "function alpha() {}\nconst beta = 1;\nclass Gamma {}\n",
      },
    });
    expect(saved.ok).toBe(true);
    expect(saved.artifact.index.symbols.some((s) => s.name === "alpha")).toBe(true);
    expect(saved.artifact.index.regions.length).toBeGreaterThan(0);
  });

  test("skill manifest layer is rendered without body", () => {
    const { buildSkillManifests, renderSkillManifestSection } = require("../../../src/code/skills");
    const manifests = buildSkillManifests([{
      name: "demo",
      description: "Demo workflow",
      shortDescription: "short demo",
      triggers: ["inspect", "demo"],
      workflowSummary: "Run demo workflow",
      path: "/tmp/demo/SKILL.md",
      enabled: true,
    }]);
    const rendered = renderSkillManifestSection(manifests);
    expect(rendered).toContain("## Skill Manifests");
    expect(rendered).toContain("Triggers: inspect, demo");
    expect(rendered).not.toContain("SECRET");
  });

  test("recordToolCallInSession updates exit codes and retries", () => {
    const { recordToolCallInSession } = require("../../../src/code/context/assembler");
    const session = {
      sessionId: "sess-exec",
      workspaceRoot,
      toolCallsSinceCommit: 0,
      workingSet: [],
      executionState: {
        modifiedFiles: [],
        lastExitCodes: [],
        retries: {},
        currentSegmentId: "",
        mode: "single_action",
        steps: {},
        segments: [],
        approvals: [],
      },
    };
    recordToolCallInSession(session, {
      tool: "bash",
      artifactId: "artifact_fail",
      preview: "failed",
      args: { command: "npm test" },
      modelPayload: { ok: false, exitCode: 1, kind: "test", failed: 2 },
    }, workspaceRoot);
    expect(session.executionState.lastExitCodes.length).toBe(1);
    expect(session.executionState.retries.bash).toBe(1);
  });

  test("execution segment stops at checkpoint", () => {
    const calls = [];
    const result = executeExecutionSegment({
      segment: {
        type: "execution_segment",
        objective: "probe",
        steps: [
          { id: "s1", tool: "read", args: { path: "a.txt" } },
          { id: "s2", tool: "read", args: { path: "b.txt" } },
        ],
        checkpoint: { after: ["s1"] },
      },
      runStep: ({ stepId, tool }) => {
        calls.push(stepId);
        return { ok: true, artifactId: `artifact_${stepId}`, tool };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBe("checkpoint");
    expect(calls).toEqual(["s1"]);
  });

  test("execution segment stops on write side effect", () => {
    const calls = [];
    const result = executeExecutionSegment({
      segment: {
        type: "execution_segment",
        steps: [
          { id: "s1", tool: "write", args: { path: "a.txt", content: "x" } },
          { id: "s2", tool: "read", args: { path: "b.txt" } },
        ],
      },
      runStep: ({ stepId, tool }) => {
        calls.push(stepId);
        return { ok: true, artifactId: `artifact_${stepId}`, tool };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBe("side_effect");
    expect(calls).toEqual(["s1"]);
  });

  test("layered prompt includes epoch block", () => {
    const layered = buildLayeredSystemPrompt({
      workspaceRoot,
      epochDynamic: "Task Contract:\n- Objective: fix bug",
      turnDynamic: "Working set note",
    });
    const layers = layered.blocks.map((b) => b.layer);
    expect(layers).toContain("epoch");
    expect(layers.indexOf("epoch")).toBeLessThan(layers.indexOf("turnDynamic"));
  });

  test("patchTaskContractFromUserMessage captures constraints", () => {
    const { patchTaskContractFromUserMessage } = require("../../../src/code/context/stateCommit");
    const contract = patchTaskContractFromUserMessage(
      { objective: "fix", successCriteria: [], constraints: [], preferences: [] },
      "Please fix the bug. Do not change package.json.",
    );
    expect(contract.constraints.join(" ")).toMatch(/package\.json/i);
  });

  test("foldCommitsIfNeeded trims long commit history", () => {
    const { applyStateCommit, foldCommitsIfNeeded } = require("../../../src/code/context/stateCommit");
    let epoch = null;
    for (let i = 0; i < 10; i += 1) {
      epoch = applyStateCommit(epoch, { factsAdd: [`fact-${i}`] });
    }
    const folded = foldCommitsIfNeeded(epoch, 8);
    expect(folded.commits.length).toBeLessThanOrEqual(3);
    expect(folded.epochId).toBeGreaterThan(1);
  });

  test("working set cap records veto metadata", () => {
    const session = { sessionId: "sess-veto", workspaceRoot };
    const plan = { retainRaw: Array.from({ length: 20 }, (_, i) => `artifact_${i}`) };
    applyWorkingSetPlan([], plan, session);
    expect(session.lastContextVetoes && session.lastContextVetoes.length).toBeGreaterThan(0);
  });

  test("rehydrateNext vetoes missing artifacts and caps per plan", () => {
    saveArtifact(workspaceRoot, "sess-rh", {
      artifactId: "artifact_live",
      tool: "read",
      raw: { ok: true, content: "function live() {}", path: "live.js" },
      summary: "live",
    });
    const session = { sessionId: "sess-rh", workspaceRoot };
    const next = applyWorkingSetPlan([], {
      rehydrateNext: [
        "artifact_missing",
        "artifact_live",
        "artifact_a",
        "artifact_b",
        "artifact_c",
        "artifact_d",
        "artifact_e",
      ],
    }, session);
    expect(next.some((e) => e.artifactId === "artifact_live")).toBe(true);
    expect(session.lastContextVetoes.some((v) => v.type === "rehydrate_missing")).toBe(true);
    expect(session.lastContextVetoes.some((v) => v.type === "rehydrate_cap")).toBe(true);
  });

  test("hydrateWorkingSetEntry resolves selector.symbol via index", () => {
    const saved = saveArtifact(workspaceRoot, "sess-sym", {
      artifactId: "artifact_sym",
      tool: "read",
      args: { path: "demo.js" },
      raw: {
        ok: true,
        path: "demo.js",
        content: "const x = 1;\nfunction targetFn() {\n  return 1;\n}\nconst y = 2;\n",
      },
    });
    expect(saved.artifact.index.symbols.some((s) => s.name === "targetFn")).toBe(true);
    const { hydrateWorkingSetEntry } = require("../../../src/code/context/workingSet");
    const hydrated = hydrateWorkingSetEntry({
      artifactId: "artifact_sym",
      selector: { symbol: "targetFn" },
    }, { sessionId: "sess-sym", workspaceRoot });
    expect(hydrated.preview).toContain("targetFn");
    expect(hydrated.selector.startLine).toBeGreaterThan(0);
  });

  test("resolveWireSystemPrompt uses layered path", () => {
    const { resolveWireSystemPrompt } = require("../../../src/code/agent");
    const text = resolveWireSystemPrompt({ workspaceRoot });
    expect(text).toContain("promptVersion:");
    expect(text).toContain("artifact_read");
  });

  test("syncMessagesToTranscript appends windowed turn deltas past full transcript", () => {
    const {
      syncMessagesToTranscript,
      ensureTranscript,
      matchTranscriptBaseline,
    } = require("../../../src/code/context/assembler");
    const { appendTranscriptMessages, loadTranscript } = require("../../../src/code/context/transcript");
    const { buildUcodeSessionLogEntries } = require("../../../src/ui/format");

    const session = { sessionId: "sess-sync-window", workspaceRoot };
    // Seed a long transcript (larger than a typical model window).
    const prior = [];
    for (let i = 0; i < 12; i += 1) {
      prior.push({ role: "user", content: `old-user-${i}` });
      prior.push({ role: "assistant", content: `old-asst-${i}` });
    }
    appendTranscriptMessages(workspaceRoot, session.sessionId, prior);
    ensureTranscript(session, workspaceRoot);
    expect(session.transcriptEvents.length).toBe(24);

    // Model window = last 4 messages, plus this turn's new user/assistant.
    const windowed = prior.slice(-4).concat([
      { role: "user", content: "brand new question" },
      { role: "assistant", content: "brand new answer" },
    ]);
    expect(windowed.length).toBeLessThan(session.transcriptEvents.length);
    expect(matchTranscriptBaseline(
      require("../../../src/code/context/transcript").transcriptEventsToMessages(session.transcriptEvents),
      windowed,
    )).toBe(4);

    syncMessagesToTranscript(session, windowed, workspaceRoot, { baselineCount: 4 });
    const loaded = loadTranscript(workspaceRoot, session.sessionId);
    const userContents = loaded.events
      .filter((event) => event.role === "user")
      .map((event) => event.content);
    expect(userContents).toContain("brand new question");
    expect(userContents.filter((text) => text === "brand new question")).toHaveLength(1);

    const { entries } = buildUcodeSessionLogEntries(
      require("../../../src/code/context/transcript").transcriptEventsToMessages(loaded.events),
    );
    const resumedUser = entries.find((row) => row.kind === "user" && row.text.includes("brand new question"));
    expect(resumedUser).toEqual(expect.objectContaining({
      kind: "user",
      text: "› brand new question",
    }));
  });

  test("artifact GC cold-marks aged entries and deletes over count", () => {
    const { markArtifactCold, gcSessionArtifacts, listArtifactFiles } = require("../../../src/code/context/artifactGc");
    for (let i = 0; i < 5; i += 1) {
      saveArtifact(workspaceRoot, "sess-gc", {
        artifactId: `artifact_gc_${i}`,
        tool: "read",
        raw: { ok: true, content: `line-${i}\n`.repeat(20), path: `f${i}.txt` },
        summary: `read f${i}`,
      });
    }
    const cold = markArtifactCold(workspaceRoot, "sess-gc", "artifact_gc_0");
    expect(cold.ok).toBe(true);
    expect(cold.artifact.cold).toBe(true);

    const gc = gcSessionArtifacts(workspaceRoot, "sess-gc", {
      maxArtifacts: 2,
      maxAgeMs: 1,
      nowMs: Date.now() + 10_000,
    });
    expect(gc.ok).toBe(true);
    expect(gc.actions.length).toBeGreaterThan(0);
    expect(listArtifactFiles(workspaceRoot, "sess-gc").length).toBeLessThanOrEqual(2);
  });

  test("saveSessionSnapshot auto-runs throttled artifact GC", () => {
    const {
      maybeGcSessionArtifacts,
      listArtifactFiles,
      getGcStampPath,
    } = require("../../../src/code/context/artifactGc");

    for (let i = 0; i < 4; i += 1) {
      saveArtifact(workspaceRoot, "sess-auto-gc", {
        artifactId: `artifact_auto_${i}`,
        tool: "read",
        raw: { ok: true, content: `auto-${i}\n`.repeat(10), path: `a${i}.txt` },
        summary: `read a${i}`,
      });
    }

    const first = saveSessionSnapshot(workspaceRoot, {
      sessionId: "sess-auto-gc",
      workspaceRoot,
      nlMessages: [{ role: "user", content: "ping" }],
      artifactGc: { maxArtifacts: 2, minIntervalMs: 60_000, nowMs: 1_000 },
    });
    expect(first.ok).toBe(true);
    expect(first.artifactGc).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
    }));
    expect(listArtifactFiles(workspaceRoot, "sess-auto-gc").length).toBeLessThanOrEqual(2);
    expect(fs.existsSync(getGcStampPath(workspaceRoot, "sess-auto-gc"))).toBe(true);

    // Under count + inside interval → skip (stamp was written at nowMs=1000).
    const second = maybeGcSessionArtifacts(workspaceRoot, "sess-auto-gc", {
      maxArtifacts: 2,
      minIntervalMs: 60_000,
      nowMs: 2_000,
    });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("throttled");

    // Over count bypasses throttle even inside the interval.
    for (let i = 0; i < 3; i += 1) {
      saveArtifact(workspaceRoot, "sess-auto-gc", {
        artifactId: `artifact_pressure_${i}`,
        tool: "bash",
        raw: { ok: true, stdout: `p${i}` },
        summary: `bash ${i}`,
      });
    }
    const third = maybeGcSessionArtifacts(workspaceRoot, "sess-auto-gc", {
      maxArtifacts: 2,
      minIntervalMs: 60_000,
      nowMs: 3_000,
    });
    expect(third.skipped).toBe(false);
    expect(listArtifactFiles(workspaceRoot, "sess-auto-gc").length).toBeLessThanOrEqual(2);
  });

  test("stableStringify sorts object keys", () => {
    const { stableStringify } = require("../../../src/code/context/stableJson");
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: { y: 1, x: 2 }, a: [{ b: 1, a: 2 }] }))
      .toBe('{"a":[{"a":2,"b":1}],"z":{"x":2,"y":1}}');
  });

  test("deleteSessionData removes commits log", () => {
    const { deleteSessionData } = require("../../../src/code/sessionStore");
    const { appendCommitLog } = require("../../../src/code/context/stateCommit");
    saveArtifact(workspaceRoot, "sess-del", {
      artifactId: "artifact_keep",
      tool: "read",
      raw: { ok: true, content: "x" },
    });
    appendCommitLog(workspaceRoot, "sess-del", { at: new Date().toISOString(), commit: { factsAdd: ["x"] } });
    const commitPath = path.join(workspaceRoot, ".ufoo", "agent", "ucode", "commits", "sess-del.jsonl");
    expect(fs.existsSync(commitPath)).toBe(true);
    const deleted = deleteSessionData(workspaceRoot, "sess-del");
    expect(deleted.ok).toBe(true);
    expect(fs.existsSync(commitPath)).toBe(false);
  });

  test("epoch layer receives anthropic cache_control", () => {
    const layered = buildLayeredSystemPrompt({
      workspaceRoot,
      epochDynamic: "Task Contract:\n- Objective: x",
      turnDynamic: "turn only",
    });
    const anthropic = systemBlocksToAnthropicPayload(layered.blocks);
    const epoch = anthropic.find((b) => b.text.includes("Task Contract"));
    const turn = anthropic.find((b) => b.text.includes("turn only"));
    expect(epoch.cache_control).toEqual({ type: "ephemeral" });
    expect(turn.cache_control).toBeUndefined();
  });

  test("persistToolResultToContext stores and reduces", () => {
    const persisted = persistToolResultToContext({
      workspaceRoot,
      sessionId: "sess-tool",
      tool: "write",
      args: { path: "a.txt" },
      rawResult: { ok: true, path: "a.txt", bytes: 3 },
    });
    expect(persisted.artifactId).toMatch(/^artifact_/);
    expect(persisted.modelPayload.path).toBe("a.txt");
  });
});
