"use strict";

const fs = require("fs");
const path = require("path");
const { createTurnIndexStore } = require("../../runtime/context/turnIndexStore");
const { stripTurnContextFromMessage } = require("../../runtime/context/turnAnalyzer");
const { replayHistory } = require("../../runtime/context/replayHistory");
const { createSessionJournal } = require("../../runtime/context/sessionJournal");
const { redactSecrets } = require("../../../runtime/privacy/redactor");

function readRuntimeEvents(workspaceRoot, namespace, sessionId) {
  const eventsFile = path.join(path.resolve(workspaceRoot || process.cwd()), ".ufoo", "agent", namespace, "runtimes", sessionId, "events.jsonl");
  if (!fs.existsSync(eventsFile)) return [];
  const raw = fs.readFileSync(eventsFile, "utf8");
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { break; }
  }
  return events;
}

function resolveNamespace(workspaceRoot, sessionId, preferredNamespace) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const candidates = [];
  if (preferredNamespace) candidates.push(preferredNamespace);
  for (const fallback of ["main", "ucode", "main-task", "global-router", "runtime"]) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  for (const ns of candidates) {
    const turnsFile = path.join(root, ".ufoo", "agent", ns, "context", `${sessionId}.turns.jsonl`);
    if (fs.existsSync(turnsFile)) return ns;
  }
  return preferredNamespace || "ucode";
}

function loadRawTurnMessages({ workspaceRoot, namespace, sessionId, turn }) {
  let journalEvents = [];
  const toMessage = (ev) => {
    const p = (ev && ev.payload) || {};
    const msg = { role: p.role || "assistant" };
    if (p.content !== undefined) msg.content = p.content;
    else if (p.preview !== undefined) msg.content = p.preview;
    if (Array.isArray(p.toolCalls) && p.toolCalls.length) msg.tool_calls = p.toolCalls;
    if (p.toolCallId) msg.tool_call_id = p.toolCallId;
    if (p.artifactId) msg.artifactId = p.artifactId;
    return msg;
  };
  try {
    const journalApi = createSessionJournal({ namespace });
    const loaded = journalApi.loadJournal(workspaceRoot, sessionId);
    journalEvents = Array.isArray(loaded && loaded.events) ? loaded.events : [];
    const matchedByTurn = journalEvents.filter((ev) => ev && ev.turnId === turn.turnId);
    if (matchedByTurn.length > 0) {
      return matchedByTurn.map(toMessage);
    }
  } catch {}

  const events = readRuntimeEvents(workspaceRoot, namespace, sessionId);
  let accepted = null;
  let terminal = null;
  let acceptedText = "";
  if (events.length > 0) {
    accepted = events.find((e) => e && e.type === "request.accepted" && (e.taskRunId === turn.turnId || e.request?.requestId === turn.turnId));
    terminal = [...events].reverse().find((e) =>
      e && e.taskRunId === turn.turnId && ["task.completed", "task.failed", "task.cancelled", "task.interrupted", "task.paused"].includes(e.type)
    );
    acceptedText = typeof accepted?.request?.text === "string"
      ? accepted.request.text
      : (typeof accepted?.text === "string" ? accepted.text : "");
    if (terminal && terminal.result && Array.isArray(terminal.result.messages)) {
      const offset = Number.isInteger(terminal.result.historyOffset) && terminal.result.historyOffset >= 0
        ? terminal.result.historyOffset
        : 0;
      const sliced = terminal.result.messages.filter((m) => m && m.role !== "system").slice(offset);
      if (sliced.length > 0) return sliced;
    }
    if (terminal && terminal.result && Array.isArray(terminal.result.turnItems)) {
      const msgs = [];
      if (acceptedText.trim()) {
        msgs.push({ role: "user", content: acceptedText });
      }
      for (const m of terminal.result.turnItems) msgs.push(m);
      if (msgs.length > 0) return msgs;
    }
  }

  if (journalEvents.length > 0) {
    const allMsgs = journalEvents.map(toMessage);
    if (Number.isInteger(turn.historyOffset) && Number.isInteger(turn.historyEnd) && turn.historyEnd > turn.historyOffset) {
      return allMsgs.slice(turn.historyOffset, turn.historyEnd);
    }
    return allMsgs;
  }

  if (events.length > 0) {
    if (accepted || terminal) {
      const msgs = [];
      if (acceptedText.trim()) {
        msgs.push({ role: "user", content: acceptedText });
      }
      if (typeof terminal?.result?.text === "string" && terminal.result.text.trim()) {
        msgs.push({ role: "assistant", content: terminal.result.text });
      }
      if (msgs.length > 0) return msgs;
    }

    const replayed = replayHistory(events);
    if (replayed.length && Number.isInteger(turn.historyOffset) && Number.isInteger(turn.historyEnd) && turn.historyEnd > turn.historyOffset) {
      return replayed.slice(turn.historyOffset, turn.historyEnd);
    }
  }

  return [];
}

function sanitizeMessageForDisplay(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const { responsesContinuation: _continuation, ...display } = stripTurnContextFromMessage(msg);
  return redactSecrets(display);
}

function emitToolEvent(callback, event = {}) {
  if (typeof callback !== "function") return;
  try {
    callback(event && typeof event === "object" ? { ...event } : {});
  } catch {
    // observer callback errors must not break recall_turn execution
  }
}

function createTurnRecallCapability(host = {}, { defaultNamespace = "" } = {}) {
  return {
    id: "turn-recall",
    version: "1.0",
    promptSections: [
      "When <turn_context> mentions off-window topics or relevant past turns and you need exact prior code, file paths, or tool results, call recall_turn (mode='search' to find turn_ids, mode='detail' with turn_id to page through raw transcript).",
    ],
    tools: [
      {
        name: "recall_turn",
        description: "Recall earlier turns from the current session index by semantic/keyword search or paginate full raw messages/tool results for a specific turn_id.",
        permissions: [],
        deferable: true,
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["search", "detail"],
              description: "Use 'search' to find relevant turns by query/topic, or 'detail' to inspect raw transcript messages for turn_id.",
            },
            query: {
              type: "string",
              description: "Search keywords, file path, symbol name, or topic (for search mode).",
            },
            topic: {
              type: "string",
              description: "Optional topic slug filter (for search mode).",
            },
            turn_id: {
              type: "string",
              description: "Specific turnId to read in detail mode.",
            },
            turnId: {
              type: "string",
              description: "Alias for turn_id in detail mode.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "Maximum search results to return (default 6).",
            },
            page: {
              type: "integer",
              minimum: 1,
              description: "1-based page number for detail mode pagination (default 1).",
            },
            page_chars: {
              type: "integer",
              minimum: 400,
              maximum: 24000,
              description: "Characters per page for detail mode (default 4000).",
            },
            pageChars: {
              type: "integer",
              minimum: 400,
              maximum: 24000,
              description: "Alias for page_chars in detail mode.",
            },
          },
          additionalProperties: false,
        },
        async handler(args = {}, context = {}) {
          const safeArgs = args && typeof args === "object" ? { ...args } : {};
          const finish = (result) => {
            if (!result || result.ok === false) {
              emitToolEvent(context.onToolEvent, {
                tool: "recall_turn",
                phase: "error",
                args: safeArgs,
                error: String((result && result.error) || "recall_turn failed"),
              });
            } else {
              emitToolEvent(context.onToolEvent, {
                tool: "recall_turn",
                phase: "end",
                args: safeArgs,
                result,
                error: "",
              });
            }
            return result;
          };

          emitToolEvent(context.onToolEvent, {
            tool: "recall_turn",
            phase: "start",
            args: safeArgs,
          });

          try {
            const workspaceRoot = context.workspaceRoot || host.projectRoot || process.cwd();
            const sessionId = String(context.sessionId || host.sessionId || "").trim();
            if (!sessionId) {
              return finish({ ok: false, code: "missing_session", error: "recall_turn requires an active sessionId" });
            }
            const preferredNs = host.contextNamespace || context.contextNamespace || defaultNamespace || context.artifactNamespace || "";
            const namespace = resolveNamespace(workspaceRoot, sessionId, preferredNs);
            const store = createTurnIndexStore({
              workspaceRoot,
              namespace,
              sessionId,
              redact: redactSecrets,
            });

            const rawTurnId = String(args.turn_id || args.turnId || "").trim();
            const mode = args.mode || (rawTurnId && !args.query ? "detail" : "search");
            if (mode === "detail") {
              const turnId = rawTurnId;
              if (!turnId) {
                return finish({ ok: false, code: "invalid_arguments", error: "turn_id is required when mode is 'detail'" });
              }
              const turn = store.getTurn(turnId);
              if (!turn) {
                return finish({ ok: false, code: "turn_not_found", error: `turn not found in current session: ${turnId}` });
              }
              const rawMessages = loadRawTurnMessages({ workspaceRoot, namespace, sessionId, turn })
                .map(sanitizeMessageForDisplay);
              const payload = redactSecrets({
                turn: {
                  turnId: turn.turnId,
                  turnIndex: turn.turnIndex,
                  topic: turn.topic,
                  turnKind: turn.turnKind,
                  outcome: turn.outcome,
                  modifiedFiles: turn.modifiedFiles,
                  touchedFiles: turn.touchedFiles,
                  artifactIds: turn.artifactIds,
                  decisions: turn.decisions,
                },
                messages: rawMessages.length ? rawMessages : [
                  { role: "user", content: turn.rawUserText || turn.userSummary },
                  ...(turn.assistantSummary ? [{ role: "assistant", content: turn.assistantSummary }] : []),
                ],
              });
              const fullText = JSON.stringify(payload, null, 2);
              const pageChars = Math.max(400, Math.min(24000, Number(args.page_chars ?? args.pageChars) || 4000));
              const totalPages = Math.max(1, Math.ceil(fullText.length / pageChars));
              const page = Math.max(1, Math.min(totalPages, Number(args.page) || 1));
              const start = (page - 1) * pageChars;
              const content = fullText.slice(start, start + pageChars);
              return finish(redactSecrets({
                ok: true,
                mode: "detail",
                sessionId,
                namespace,
                turnId: turn.turnId,
                topic: turn.topic,
                outcome: turn.outcome,
                page,
                totalPages,
                totalChars: fullText.length,
                hasMore: page < totalPages,
                content,
              }));
            }

            const limit = Math.max(1, Math.min(20, Number(args.limit) || 6));
            const hits = store.search(args.query || "", { limit, topic: args.topic });
            return finish(redactSecrets({
              ok: true,
              mode: "search",
              sessionId,
              namespace,
              count: hits.length,
              turns: hits.map(({ turn, score, matchedTerms }) => ({
                turnId: turn.turnId,
                turn_id: turn.turnId,
                turnIndex: turn.turnIndex,
                topic: turn.topic,
                turnKind: turn.turnKind,
                outcome: turn.outcome,
                userSummary: turn.userSummary,
                assistantSummary: turn.assistantSummary,
                modifiedFiles: turn.modifiedFiles,
                touchedFiles: turn.touchedFiles,
                artifactIds: turn.artifactIds,
                score,
                matchedTerms,
              })),
              topics: store.listTopics().slice(0, 12),
            }));
          } catch (error) {
            emitToolEvent(context.onToolEvent, {
              tool: "recall_turn",
              phase: "error",
              args: safeArgs,
              error: String((error && error.message) || "recall_turn failed"),
            });
            throw error;
          }
        },
      },
    ],
  };
}

module.exports = { createTurnRecallCapability };
