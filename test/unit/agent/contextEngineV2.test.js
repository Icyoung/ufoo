"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTurnIndexStore } = require("../../../src/agents/runtime/context/turnIndexStore");
const {
  stripTurnContextFromMessage,
  classifyTurnKind,
  buildDeterministicTurnRecord,
  backfillMissingTurns,
  createAsyncTurnEnricher,
} = require("../../../src/agents/runtime/context/turnAnalyzer");
const { createTopicSelector } = require("../../../src/agents/runtime/context/topicSelector");
const { createSlidingWindowManager, attachTurnContextToMessage } = require("../../../src/agents/runtime/context/slidingWindowManager");
const { createTurnRecallCapability } = require("../../../src/agents/capabilities/turnRecall");
const { createSessionJournal } = require("../../../src/agents/runtime/context/sessionJournal");
const { redactSecrets } = require("../../../src/runtime/privacy/redactor");
const { routeAgentHandler } = require("../../../src/tools/handlers/routeAgent");
const { appendReport } = require("../../../src/coordination/report/store");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-v2-ctx-"));
}

describe("Agent Runtime Context Engine V2", () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("turnIndexStore handles CRUD, additive Phase A+B merge, torn tails, CJK+ID search, redaction, and remove()", () => {
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-v2-1", redact: redactSecrets });
    const phaseA = store.upsertTurn({
      turnId: "turn-1",
      turnIndex: 0,
      historyOffset: 0,
      historyEnd: 4,
      topic: "auth-fix",
      rawUserText: "修复登录接口的 token 锁问题 Bearer sk-ant-secret1234567890",
      userSummary: "修复登录接口 token 锁问题",
      assistantSummary: "已在 src/auth/sessionLock.js 修复并发锁",
      touchedFiles: ["src/auth/sessionLock.js", "test/auth.test.js"],
      modifiedFiles: ["src/auth/sessionLock.js"],
      artifactIds: ["art_diff_01"],
      keywords: ["sessionLock", "acquireAuthLock"],
      contentHash: "hash_a1",
    }, { phase: "A" });

    expect(phaseA.turnId).toBe("turn-1");
    expect(fs.readFileSync(store.turnsFile, "utf8")).not.toContain("sk-ant-secret1234567890");

    // Stale Phase B with old hash is rejected; matching hash merges additively without erasing modifiedFiles.
    store.upsertTurn({
      turnId: "turn-1",
      topic: "stale-topic",
      userSummary: "stale summary",
      enrichmentVersion: 2,
    }, { phase: "B", expectedHash: "wrong_hash" });
    expect(store.getTurn("turn-1").topic).toBe("auth-fix");

    const phaseB = store.upsertTurn({
      turnId: "turn-1",
      topic: "login-concurrency",
      userSummary: "修复登录会话并发锁竞争",
      decisions: ["Use mutex per user session"],
      keywords: ["mutex"],
      enrichmentVersion: 2,
    }, { phase: "B", expectedHash: "hash_a1" });
    expect(phaseB.topic).toBe("login-concurrency");
    expect(phaseB.modifiedFiles).toEqual(["src/auth/sessionLock.js"]);
    expect(phaseB.artifactIds).toEqual(["art_diff_01"]);
    expect(phaseB.keywords).toEqual(expect.arrayContaining(["sessionLock", "acquireAuthLock", "mutex"]));

    // Torn tail truncation does not lose turn-1.
    fs.appendFileSync(store.turnsFile, "{\"turnId\":\"broken-incomplete");
    store.upsertTurn({
      turnId: "turn-2",
      topic: "ui-layout",
      rawUserText: "Adjust sidebar padding in SidebarPanel.tsx",
      userSummary: "Adjust sidebar padding",
      modifiedFiles: ["src/ui/SidebarPanel.tsx"],
    }, { phase: "A" });

    expect(store.listTurns().map((t) => t.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(store.listTopics().length).toBe(2);

    // CJK bigram and identifier search.
    const cjkHits = store.search("并发锁");
    expect(cjkHits[0].turn.turnId).toBe("turn-1");
    const symHits = store.search("SidebarPanel.tsx");
    expect(symHits[0].turn.turnId).toBe("turn-2");

    // Window state & remove().
    store.saveWindowState({ anchorTurnId: "turn-1", evictionLevel: 0, token: "sk-proj-abc123456789012345" });
    expect(fs.readFileSync(store.windowFile, "utf8")).not.toContain("sk-proj-abc123456789012345");
    expect(store.loadWindowState().anchorTurnId).toBe("turn-1");

    store.remove();
    expect(fs.existsSync(store.turnsFile)).toBe(false);
    expect(fs.existsSync(store.windowFile)).toBe(false);
  });

  test("turnAnalyzer removes runtime context, extracts OpenAI/Anthropic records, backfills, and drains async enricher cleanly", async () => {
    const user = { role: "user", content: "Check `session_nonce` in `src/auth/login.js`" };
    const wrapped = attachTurnContextToMessage(user, "<turn_context>\n<topic_map>...</topic_map>\n</turn_context>");
    expect(stripTurnContextFromMessage(wrapped)).toEqual(user);

    expect(classifyTurnKind({ requestKind: "worker-report" })).toBe("system_wake");
    expect(classifyTurnKind({ requestKind: "user", resume: true })).toBe("resumed_interaction");

    const record = buildDeterministicTurnRecord({
      turnId: "t-anth",
      turnIndex: 0,
      historyOffset: 0,
      turnMessages: [
        wrapped,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret internal thought", signature: "sig-1" },
            { type: "tool_use", id: "tu_1", name: "edit_file", input: { path: "./src/auth/login.js" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "{\"artifactId\":\"art_edit_1\"}" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Updated src/auth/login.js cleanly." }] },
      ],
      outcome: "completed",
    });

    expect(record.rawUserText).toBe("Check `session_nonce` in `src/auth/login.js`");
    expect(record.modifiedFiles).toEqual(["src/auth/login.js"]);
    expect(record.artifactIds).toEqual(["art_edit_1"]);
    expect(record.keywords).toEqual(expect.arrayContaining(["session_nonce"]));

    // Backfill from journal messages.
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-bf" });
    const backfilled = backfillMissingTurns({
      store,
      journalMessages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
        { role: "assistant", content: "Second answer" },
      ],
    });
    expect(backfilled).toHaveLength(2);
    expect(store.listTurns().map((t) => [t.historyOffset, t.historyEnd])).toEqual([[0, 2], [2, 4]]);

    // Async enricher with Phase B + clean close() (including aborted slow call).
    const enricher = createAsyncTurnEnricher({
      store,
      enabled: true,
      timeoutMs: 3000,
      runAuxModel: async ({ turn }) => JSON.stringify({
        topic: "session-bootstrap",
        userSummary: `Enriched: ${turn.userSummary}`,
        decisions: ["Preserve backward compatibility"],
        keywords: ["backfill"],
      }),
    });
    enricher.enqueue(backfilled[0]);
    await enricher.flush();
    expect(store.getTurn(backfilled[0].turnId).enrichmentVersion).toBe(2);
    expect(store.getTurn(backfilled[0].turnId).topic).toBe("session-bootstrap");
    enricher.close();
  });

  test("topicSelector runs Tier 0 bypass, Tier 1 local path/ID/founding selection, and bounded Tier 2 without resolvedIntent", async () => {
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-sel" });
    const turns = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push(store.upsertTurn({
        turnId: `turn_${i}`,
        turnIndex: i,
        historyOffset: i * 2,
        historyEnd: i * 2 + 2,
        topic: i < 3 ? "database-schema" : "ui-polish",
        rawUserText: i === 0 ? "Keep database_nonce_v2 unchanged across migrations" : `Work on step ${i}`,
        userSummary: i === 0 ? "Keep database_nonce_v2 unchanged" : `Step ${i}`,
        assistantSummary: `Completed step ${i}`,
        modifiedFiles: i === 1 ? ["src/db/schema.sql"] : [`src/ui/comp${i}.js`],
        keywords: i === 0 ? ["database_nonce_v2"] : [],
      }, { phase: "A" }));
    }

    const windowIds = turns.slice(-5).map((t) => t.turnId);

    // Tier 0 system_wake bypass.
    const selectorNoModel = createTopicSelector();
    const wakeSel = await selectorNoModel.select({
      currentQuery: "Background job finished",
      requestKind: "system_wake",
      allTurns: turns,
      windowTurnIds: windowIds,
      store,
    });
    expect(wakeSel.mode).toBe("bypass");

    // Tier 1 exact symbol/path match picks turn_0 / turn_1 even though out of window.
    const tier1 = await selectorNoModel.select({
      currentQuery: "Please re-check src/db/schema.sql and database_nonce_v2",
      allTurns: turns,
      windowTurnIds: windowIds,
      store,
    });
    expect(tier1.mode).toBe("tier1_local");
    expect(tier1.selectedTurns.map((t) => t.turnId)).toEqual(expect.arrayContaining(["turn_0", "turn_1"]));

    // Tier 2 optional fast model validates IDs, never rewrites user intent, and falls back on timeout.
    const selectorWithModel = createTopicSelector({
      enableModelSelector: true,
      modelTimeoutMs: 500,
      runAuxModel: async () => JSON.stringify({
        isNewTopic: false,
        matchedTopics: ["database-schema"],
        referencedTurnIds: ["turn_1", "hallucinated_turn_999"],
        resolvedIntent: "SHOULD_BE_IGNORED",
      }),
    });
    const tier2 = await selectorWithModel.select({
      currentQuery: "Review the architectural decision we made before",
      allTurns: turns,
      windowTurnIds: windowIds,
      store,
    });
    expect(tier2.mode).toBe("tier2_model");
    expect(tier2.resolvedIntent).toBeUndefined();
    expect(tier2.selectedTurns.map((t) => t.turnId)).toEqual(expect.arrayContaining(["turn_0", "turn_1"]));
    expect(tier2.selectedTurns.map((t) => t.turnId)).not.toContain("hallucinated_turn_999");

    // Timeout fallback.
    const selectorTimeout = createTopicSelector({
      enableModelSelector: true,
      modelTimeoutMs: 250,
      runAuxModel: (_input) => new Promise((_resolve, reject) => {
        _input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    const fallbackSel = await selectorTimeout.select({
      currentQuery: "Unclear historical reference",
      allTurns: turns,
      windowTurnIds: windowIds,
      store,
      forceTier2: true,
    });
    expect(fallbackSel.mode).toBe("tier1_local");
  });

  test("slidingWindowManager enforces Step=2 alignment, hot-topic cap, system_wake quota, per-turn caching, and Level 1-3 eviction preserving thinking/tools", async () => {
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-win" });
    const topicSelector = createTopicSelector();
    const manager = createSlidingWindowManager({
      turnIndexStore: store,
      topicSelector,
    });

    const history = [];
    for (let i = 0; i < 8; i += 1) {
      const turnMessages = [
        { role: "user", content: `Prompt ${i}` },
        { role: "assistant", content: `Reply ${i}` },
      ];
      const offset = history.length;
      history.push(...turnMessages);
      store.upsertTurn({
        turnId: `t_${i}`,
        turnIndex: i,
        historyOffset: offset,
        historyEnd: offset + 2,
        turnKind: i === 6 ? "system_wake" : "user",
        topic: i === 0 ? "alpha-goal" : (i % 2 === 0 ? `topic-${i}` : `other-${i}`),
        rawUserText: i === 0 ? "Original constraint: keep api_v1_flag" : `Prompt ${i}`,
        userSummary: i === 0 ? "keep api_v1_flag" : `Prompt ${i}`,
        keywords: i === 0 ? ["api_v1_flag"] : [],
      }, { phase: "A" });
    }

    // Turn 8 round 1: prepares window, injects ephemeral <turn_context> without mutating original messages.
    const round1Msgs = [...history, { role: "user", content: "继续验证 api_v1_flag" }];
    const prep1 = await manager.prepare({
      messages: round1Msgs,
      model: "gpt-4o",
      historyOffset: history.length,
      turnId: "turn-8",
    });
    expect(round1Msgs.at(-1).content).toBe("继续验证 api_v1_flag");
    expect(prep1.messages.at(-1).content).toContain("<turn_context>");
    expect(prep1.messages.at(-1).content).toContain("api_v1_flag");
    // Step=2 anchor persisted in window state.
    const anchorAfterT8 = store.loadWindowState().anchorTurnId;

    // Same turn round 2 reuses cached <turn_context>.
    const events = [];
    const prep1R2 = await manager.prepare({
      messages: [...history, { role: "user", content: "继续验证 api_v1_flag" }, { role: "assistant", content: "Running check" }],
      model: "gpt-4o",
      historyOffset: history.length,
      turnId: "turn-8",
      onEvent: (type, payload) => events.push({ type, ...(payload || {}) }),
    });
    expect(events.find((e) => e.type === "context.select.completed")?.cached).toBe(true);
    expect(prep1R2.messages.at(-2).content).toBe(prep1.messages.at(-1).content);

    // Next turn (+1 user turn) keeps the SAME Step=2 anchor so KV cache prefix stays append-only!
    history.push({ role: "user", content: "继续验证 api_v1_flag" }, { role: "assistant", content: "Checked." });
    store.upsertTurn({
      turnId: "t_8",
      turnIndex: 8,
      historyOffset: 16,
      historyEnd: 18,
      topic: "topic-8",
      rawUserText: "继续验证 api_v1_flag",
    }, { phase: "A" });
    await manager.prepare({
      messages: [...history, { role: "user", content: "Next small step" }],
      model: "gpt-4o",
      historyOffset: history.length,
      turnId: "turn-9",
    });
    expect(store.loadWindowState().anchorTurnId).toBe(anchorAfterT8);

    // Overflow & force Level 3 eviction preserves Anthropic signed thinking & current round tool pairing.
    const tightManager = createSlidingWindowManager({
      policy: { contextWindowTokens: 1500 },
      turnIndexStore: store,
      topicSelector,
    });
    const bigToolPayload = "X".repeat(3000);
    const emergencyCurrent = [
      { role: "user", content: "Inspect giant file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "must keep signed thinking", signature: "sig_anthropic_123" },
          { type: "tool_use", id: "toolu_old", name: "read_file", input: { path: "big.txt" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: bigToolPayload }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_latest", name: "read_file", input: { path: "small.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_latest", content: "latest small output" }] },
    ];
    const emergencyPrep = await tightManager.prepare({
      messages: [...history, ...emergencyCurrent],
      model: "claude-sonnet-4",
      historyOffset: history.length,
      turnId: "turn-overflow",
      force: true,
    });
    expect(emergencyPrep.meta.evictionLevel).toBeGreaterThanOrEqual(2);
    // Tool result of earlier round truncated while preserving ID & latest round + signed thinking intact.
    const serialized = JSON.stringify(emergencyPrep.messages);
    expect(serialized).toContain("sig_anthropic_123");
    expect(serialized).toContain("toolu_old");
    expect(serialized).toContain("latest small output");
    expect(serialized).not.toContain(bigToolPayload);
  });

  test("turnRecall capability searches turns and paginates journal/runtime transcript with secret redaction", async () => {
    const sid = "sess-recall";
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: sid, redact: redactSecrets });
    const journal = createSessionJournal({ namespace: "ucode" });
    const longDetail = `START_DETAIL ${"line_of_code ".repeat(90)} api_key=sk-ant-recallsecret1234567890 END_DETAIL`;
    journal.appendTurnMessages(root, sid, "t-recall-1", [
      { role: "user", content: "Inspect TokenService. Preserve <turn_context>only staging</turn_context> exactly." },
      { role: "assistant", content: longDetail },
    ]);
    store.upsertTurn({
      turnId: "t-recall-1",
      turnIndex: 0,
      historyOffset: 0,
      historyEnd: 2,
      topic: "token-service",
      rawUserText: "Inspect TokenService",
      userSummary: "Inspect TokenService",
      assistantSummary: "Checked TokenService output",
      modifiedFiles: ["src/auth/tokenService.js"],
    }, { phase: "A" });

    const cap = createTurnRecallCapability({ projectRoot: root, contextNamespace: "ucode" }, { defaultNamespace: "ucode" });
    const tool = cap.tools[0];
    const searchRes = await tool.handler({ mode: "search", query: "TokenService" }, { workspaceRoot: root, sessionId: sid });
    expect(searchRes.ok).toBe(true);
    expect(searchRes.turns[0].turnId).toBe("t-recall-1");

    const page1 = await tool.handler({ mode: "detail", turn_id: "t-recall-1", page: 1, page_chars: 700 }, { workspaceRoot: root, sessionId: sid });
    expect(page1.ok).toBe(true);
    expect(page1.totalPages).toBeGreaterThan(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.content).toContain("<turn_context>only staging</turn_context>");

    const lastPage = await tool.handler({ mode: "detail", turn_id: "t-recall-1", page: page1.totalPages, page_chars: 700 }, { workspaceRoot: root, sessionId: sid });
    expect(lastPage.ok).toBe(true);
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.content).not.toContain("sk-ant-recallsecret1234567890");
    expect(lastPage.content).toContain("END_DETAIL");

    // When both runtimes/<sessionId>/events.jsonl and journal/<sessionId>.jsonl exist (as in ucode),
    // recall_turn detail prioritizes journal turnId messages (including tool_calls and tool results)
    // and accepts camelCase turnId/pageChars aliases.
    const { createRuntimeStore } = require("../../../src/agents/runtime/context/runtimeStore");
    const sidDual = "sess-dual-ucode";
    const dualStore = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: sidDual, redact: redactSecrets });
    const dualJournal = createSessionJournal({ namespace: "ucode" });
    const dualRuntime = createRuntimeStore({ workspaceRoot: root, namespace: "ucode", sessionId: sidDual, redact: redactSecrets });
    dualRuntime.append({ type: "request.accepted", taskRunId: "t-dual-1", request: { taskRunId: "t-dual-1", text: "Write src/math.js" } });
    dualRuntime.append({ type: "task.completed", taskRunId: "t-dual-1", result: { text: "Wrote src/math.js" } });
    dualJournal.appendTurnMessages(root, sidDual, "t-dual-1", [
      { role: "user", content: "Write src/math.js" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{\"path\":\"src/math.js\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"ok\":true,\"path\":\"src/math.js\"}" },
      { role: "assistant", content: "Wrote src/math.js" },
    ]);
    dualStore.upsertTurn({
      turnId: "t-dual-1",
      turnIndex: 0,
      historyOffset: 0,
      historyEnd: 4,
      topic: "src-math",
      rawUserText: "Write src/math.js",
      modifiedFiles: ["src/math.js"],
    }, { phase: "A" });
    const toolEvents = [];
    const onToolEvent = (ev) => toolEvents.push(ev);
    const dualSearch = await tool.handler({ mode: "search", query: "math" }, { workspaceRoot: root, sessionId: sidDual, onToolEvent });
    expect(dualSearch.turns[0].turnId).toBe("t-dual-1");
    expect(dualSearch.turns[0].turn_id).toBe("t-dual-1");
    const dualDetail = await tool.handler({ mode: "detail", turnId: "t-dual-1", pageChars: 4000 }, { workspaceRoot: root, sessionId: sidDual, onToolEvent });
    expect(dualDetail.ok).toBe(true);
    const parsedDual = JSON.parse(dualDetail.content);
    expect(parsedDual.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    const invalidDetail = await tool.handler({ mode: "detail" }, { workspaceRoot: root, sessionId: sidDual, onToolEvent });
    expect(invalidDetail.ok).toBe(false);
    expect(invalidDetail.code).toBe("invalid_arguments");
    const missingSession = await tool.handler({ mode: "search", query: "math" }, { workspaceRoot: root, onToolEvent });
    expect(missingSession.ok).toBe(false);
    expect(missingSession.code).toBe("missing_session");
    expect(toolEvents.map((e) => [e.tool, e.phase])).toEqual([
      ["recall_turn", "start"],
      ["recall_turn", "end"],
      ["recall_turn", "start"],
      ["recall_turn", "end"],
      ["recall_turn", "start"],
      ["recall_turn", "error"],
      ["recall_turn", "start"],
      ["recall_turn", "error"],
    ]);
    expect(toolEvents[5].error).toContain("turn_id is required");
    expect(toolEvents[7].error).toContain("requires an active sessionId");
  });

  test("routeAgent V2 uses historical delegated tasks and reports.jsonl without mutating all-agents.json", () => {
    const { getUfooPaths } = require("../../../src/coordination/state/paths");
    const { agentsFile } = getUfooPaths(root);
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    const agentsPayload = {
      agents: {
        "worker-a": { agent_type: "codex", launch_mode: "internal", role: "developer", nickname: "Alice", activity_state: "idle", status: "active", pid: process.pid },
        "worker-b": { agent_type: "claude", launch_mode: "internal", role: "developer", nickname: "Bob", activity_state: "idle", status: "active", pid: process.pid },
      },
    };
    const rawBefore = JSON.stringify(agentsPayload, null, 2);
    fs.writeFileSync(agentsFile, rawBefore, "utf8");

    appendReport(root, {
      entry_id: "r1",
      task_id: "t1",
      agent_id: "worker-b",
      phase: "done",
      ok: true,
      summary: "Fixed OAuth callback in src/auth/oauthHandler.js",
    });

    const selected = routeAgentHandler({
      projectRoot: root,
      internalAgentsOnly: true,
      agentManagement: {
        snapshot: () => ({
          tasks: {
            t1: { agentId: "worker-b", modifiedFiles: ["src/auth/oauthHandler.js"], topic: "oauth" },
          },
        }),
      },
    }, { request: "Please update src/auth/oauthHandler.js" });

    expect(selected.target).toBe("worker-b");
    expect(selected.confidence).toBeGreaterThanOrEqual(0.8);
    expect(fs.readFileSync(agentsFile, "utf8")).toBe(rawBefore);
  });

  test("contextBudget preserves atomic tool units / excludes image bytes and createAgentRuntime handles context_length_exceeded via slidingWindowManager", async () => {
    const {
      historyUnits,
      estimateMessagesTokens,
      summaryMessage,
    } = require("../../../src/agents/runtime/context/contextBudget");
    const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");
    const { createAgentRuntime } = require("../../../src/agents/runtime");

    const openai = [
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "one" },
      { role: "tool", tool_call_id: "b", content: "two" },
    ];
    const anthropic = [
      { role: "assistant", content: [{ type: "tool_use", id: "c" }, { type: "tool_use", id: "d" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "three" }, { type: "tool_result", tool_use_id: "d", content: "four" }] },
    ];
    expect(historyUnits([...openai, ...anthropic]).map((u) => [u.messages.length, u.complete])).toEqual([[3, true], [2, true]]);
    expect(historyUnits(openai.slice(0, 2))[0].complete).toBe(false);

    const bytes = "a".repeat(100000);
    const visionMsgs = [
      { role: "user", content: [{ type: "text", text: "keep session_nonce" }, { type: "image_url", image_url: { url: `data:image/png;base64,${bytes}` } }] },
    ];
    const stripped = visionMsgs.map(summaryMessage);
    expect(JSON.stringify(stripped)).not.toContain(bytes);
    expect(estimateMessagesTokens(visionMsgs) - estimateMessagesTokens(stripped)).toBe(2000);

    // Retry once on context_length_exceeded when history shrinks.
    let shrinkCalls = 0;
    const shrinkTransport = createOpenAiChatTransport({
      resolveUrl: () => "https://isolated.invalid",
      runTurn: async () => {
        shrinkCalls += 1;
        if (shrinkCalls === 1) throw Object.assign(new Error("input exceeds the context window"), { code: "context_length_exceeded" });
        return { text: "已完成", toolCalls: [] };
      },
      normalizeToolName: (n) => n,
      normalizeToolCallArgs: JSON.parse,
      toJsonString: JSON.stringify,
      clipText: (v) => v,
    });
    const history = Array.from({ length: 6 }, (_, i) => ([
      { role: "user", content: `turn ${i}` },
      { role: "assistant", content: `reply ${i}` },
    ])).flat();
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-ovf" });
    for (let i = 0; i < 6; i += 1) {
      store.upsertTurn({ turnId: `ov_${i}`, turnIndex: i, historyOffset: i * 2, historyEnd: i * 2 + 2, topic: `t-${i}` }, { phase: "A" });
    }
    const rtRetry = createAgentRuntime({ transport: shrinkTransport, profile: { capabilities: [] }, capabilities: [] });
    try {
      const okRes = await rtRetry.run({
        model: "gpt-4o",
        prompt: "继续任务",
        historyMessages: history,
        contextManager: createSlidingWindowManager({ turnIndexStore: store, topicSelector: createTopicSelector() }),
      });
      expect(shrinkCalls).toBe(2);
      expect(okRes.finalText).toBe("已完成");
    } finally {
      await rtRetry.close();
    }

    // Single-turn unshrinkable prompt stops immediately after 1 call with context_budget_exceeded.
    const failRunTurn = jest.fn().mockRejectedValue(Object.assign(new Error("prompt is too long"), { code: "context_length_exceeded" }));
    const failTransport = createOpenAiChatTransport({
      resolveUrl: () => "https://isolated.invalid",
      runTurn: failRunTurn,
      normalizeToolName: (n) => n,
      normalizeToolCallArgs: JSON.parse,
      toJsonString: JSON.stringify,
      clipText: (v) => v,
    });
    const rtFail = createAgentRuntime({ transport: failTransport, profile: { capabilities: [] }, capabilities: [] });
    try {
      const failRes = await rtFail.run({
        model: "gpt-4o",
        prompt: "保留这条请求",
        contextManager: createSlidingWindowManager(),
      });
      expect(failRunTurn).toHaveBeenCalledTimes(1);
      expect(failRes.stopReason).toBe("context_budget_exceeded");
      expect(failRes.messages).toEqual([{ role: "user", content: "保留这条请求" }]);
    } finally {
      await rtFail.close();
    }
  });

  test("reconciles overshot historyEnd from in-turn ephemeral messages and preserves hot-topic window without tail fragmentation", async () => {
    const { partitionHistoricalMessages } = require("../../../src/agents/runtime/context/slidingWindowManager");
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-overshot" });

    // Build 7 turns where Turn 0 and Turn 3 had overshot historyEnd (e.g. from unpersisted auto-continue messages)
    // and Turn 6 has multiple tool rounds.
    const historicalMessages = [];
    const turnStarts = [];
    for (let t = 0; t < 7; t += 1) {
      turnStarts.push(historicalMessages.length);
      historicalMessages.push({ role: "user", content: `用户第 ${t} 轮指令` });
      for (let step = 0; step < 3; step += 1) {
        const callId = `call_${t}_${step}`;
        historicalMessages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name: "edit", arguments: '{"path":"scene.js"}' } }],
        });
        historicalMessages.push({
          role: "tool",
          tool_call_id: callId,
          content: `{"ok":true,"path":"scene.js"}`,
        });
      }
      historicalMessages.push({ role: "assistant", content: `第 ${t} 轮完成` });
    }

    for (let t = 0; t < 7; t += 1) {
      const start = turnStarts[t];
      const trueEnd = t + 1 < 7 ? turnStarts[t + 1] : historicalMessages.length;
      // Simulate overshot historyEnd on turns 0 and 3 (+9 and +5 ephemeral messages)
      const overshotEnd = t === 0 ? trueEnd + 9 : (t === 3 ? trueEnd + 5 : trueEnd);
      store.upsertTurn({
        turnId: `turn_${t}`,
        turnIndex: t,
        historyOffset: start,
        historyEnd: overshotEnd,
        turnKind: "user",
        outcome: "completed",
        topic: t >= 2 ? "scene" : "package",
        userSummary: `用户第 ${t} 轮指令`,
        assistantSummary: `第 ${t} 轮完成`,
        modifiedFiles: ["scene.js"],
      }, { phase: "A" });
    }

    // Even before backfillMissingTurns runs, partitionHistoricalMessages clamps overshot ends and never splits tool steps into tail_* units
    const unitsBeforeRepair = partitionHistoricalMessages(historicalMessages, store.listTurns());
    expect(unitsBeforeRepair.map((u) => u.turnId)).toEqual([
      "turn_0", "turn_1", "turn_2", "turn_3", "turn_4", "turn_5", "turn_6",
    ]);

    // And backfillMissingTurns repairs the persisted historyEnd on disk
    backfillMissingTurns({ store, journalMessages: historicalMessages });
    const repairedTurns = store.listTurns();
    for (let t = 0; t < 7; t += 1) {
      const expectedEnd = t + 1 < 7 ? turnStarts[t + 1] : historicalMessages.length;
      expect(repairedTurns[t].historyOffset).toBe(turnStarts[t]);
      expect(repairedTurns[t].historyEnd).toBe(expectedEnd);
    }

    // Because turns 2..6 all share topic="scene" (5 turns >= hotTopicThreshold=3), hot-topic expansion keeps >5 turns verbatim
    const manager = createSlidingWindowManager({
      turnIndexStore: store,
      topicSelector: createTopicSelector(),
    });
    const prepared = await manager.prepare({
      messages: [...historicalMessages, { role: "user", content: "另外鹈鹕的嘴颜色不对吧" }],
      historyOffset: historicalMessages.length,
      model: "gpt-4o",
      turnId: "turn_7",
    });
    expect(prepared.meta.rawTurnCount).toBe(7);
    expect(prepared.meta.offWindowCount).toBe(0);
  });

  test("defaultAuxModelForProvider and resolveRuntimeConfig default codex to gpt-6-luna and claude to claude-haiku-5-5", () => {
    const { defaultAuxModelForProvider, SETTINGS_MODEL_DEFAULTS } = require("../../../src/config");
    const { resolveRuntimeConfig } = require("../../../src/agents/providers/runtimeConfig");

    expect(SETTINGS_MODEL_DEFAULTS.aux).toMatchObject({
      codex: "gpt-6-luna",
      claude: "claude-haiku-5-5",
    });
    expect(defaultAuxModelForProvider("codex")).toBe("gpt-6-luna");
    expect(defaultAuxModelForProvider("codex-cli")).toBe("gpt-6-luna");
    expect(defaultAuxModelForProvider("claude")).toBe("claude-haiku-5-5");
    expect(defaultAuxModelForProvider("claude-cli")).toBe("claude-haiku-5-5");
    expect(defaultAuxModelForProvider("anthropic")).toBe("claude-haiku-5-5");
    expect(defaultAuxModelForProvider("openai")).toBe("");
    expect(defaultAuxModelForProvider("custom")).toBe("");

    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "codex" }).auxModel).toBe("gpt-6-luna");
    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "claude" }).auxModel).toBe("claude-haiku-5-5");
    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "anthropic" }).auxModel).toBe("claude-haiku-5-5");
  });

  test("preserves read tool code content across turns in sessionJournal and assembleModelContext for cross-turn prefix cache continuity", () => {
    const { persistToolResultToContext, assembleModelContext } = require("../../../src/code/context/assembler");
    const { appendTurnMessages } = require("../../../src/code/conversation/sessionJournal");
    const { loadTranscript } = require("../../../src/code/context/transcript");

    const sessionId = "sess-cross-turn-code";
    const codeBody = Array.from({ length: 120 }, (_, idx) => `function part_${idx}() { return ${idx}; }`).join("\n");
    expect(codeBody.length).toBeGreaterThan(2500);

    const persisted = persistToolResultToContext({
      workspaceRoot: root,
      sessionId,
      tool: "read",
      args: { path: "scene.js" },
      rawResult: {
        ok: true,
        path: "scene.js",
        startLine: 1,
        endLine: 120,
        totalLines: 120,
        truncated: false,
        content: codeBody,
      },
    });

    const toolMessageContentInTurn2 = JSON.stringify(persisted.modelPayload);
    expect(persisted.modelPayload.content).toBe(codeBody);

    appendTurnMessages(root, sessionId, "turn_2", [
      { role: "user", content: "先看一下 scene.js 的实现" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_read_1", type: "function", function: { name: "read", arguments: '{"path":"scene.js"}' } }],
      },
      {
        role: "tool",
        tool_call_id: "call_read_1",
        content: toolMessageContentInTurn2,
      },
      { role: "assistant", content: "看完了。" },
    ], { scope: "turn" });

    const transcript = loadTranscript(root, sessionId);
    const assembledForTurn3 = assembleModelContext({
      sessionId,
      workspaceRoot: root,
      transcriptEvents: transcript.events,
    }, { workspaceRoot: root });

    const turn3ToolMsg = assembledForTurn3.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_read_1");
    expect(turn3ToolMsg).toBeDefined();
    // Byte-for-byte identical to Turn 2's live tool message, keeping full codeBody
    expect(turn3ToolMsg.content).toBe(toolMessageContentInTurn2);
    expect(JSON.parse(turn3ToolMsg.content).content).toContain("function part_119()");
  });

  test("dehydrates JSON bash outputs (>12 array items folded, Base64 stripped) and stamps Anthropic ShortStableSnapshot cache breakpoint", async () => {
    const { reduceBashResult, looksLikeLargeBase64 } = require("../../../src/code/context/reducers");

    const fakeBase64 = `AbCdEf0123456789+/`.repeat(20);
    expect(looksLikeLargeBase64(fakeBase64)).toBe(true);

    const jsonPayload = {
      status: "ok",
      avatar: `data:image/png;base64,${fakeBase64}`,
      rawBlob: fakeBase64,
      items: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` })),
    };

    const reduced = reduceBashResult(
      { ok: true, code: 0, stdout: JSON.stringify(jsonPayload, null, 2), stderr: "" },
      "art_json_1",
      { command: "curl -s http://localhost:3000/api/items" },
    );

    const parsedOut = JSON.parse(reduced.modelPayload.stdoutTail);
    expect(parsedOut.status).toBe("ok");
    expect(parsedOut.avatar).toMatch(/\[omitted (?:base64 blob|data-uri base64)/);
    expect(parsedOut.rawBlob).toMatch(/\[omitted base64 blob/);
    expect(parsedOut.items).toHaveLength(13);
    expect(parsedOut.items[0]).toEqual({ id: 1, name: "item-1" });
    expect(parsedOut.items[11]).toEqual({ id: 12, name: "item-12" });
    expect(parsedOut.items[12]).toBe("[omitted 18 additional items]");

    // Verify ShortStableSnapshot boundary symbol is stamped on histMsgs tail when <turn_context> is present
    const store = createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "sess-anth-bp" });
    const history = [];
    for (let i = 0; i < 7; i += 1) {
      history.push({ role: "user", content: `Q${i}` }, { role: "assistant", content: `A${i}` });
      store.upsertTurn({
        turnId: `t_${i}`,
        turnIndex: i,
        historyOffset: i * 2,
        historyEnd: i * 2 + 2,
        topic: `topic_${i}`,
        userSummary: `Q${i}`,
      }, { phase: "A" });
    }
    const manager = createSlidingWindowManager({
      turnIndexStore: store,
      topicSelector: createTopicSelector(),
    });
    const prepared = await manager.prepare({
      messages: [...history, { role: "user", content: "New question" }],
      historyOffset: history.length,
      model: "claude-opus-5-5",
      turnId: "t_7",
    });

    const boundarySym = Symbol.for("ufoo.stableHistoryBoundary");
    const boundaryMsg = prepared.messages[prepared.historyOffset - 1];
    expect(boundaryMsg[boundarySym]).toBe(true);
  });
});
