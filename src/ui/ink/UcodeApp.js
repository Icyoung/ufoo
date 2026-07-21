"use strict";

/**
 * Ink-based ucode TUI rendered via React + ink.
 *
 * Activation: this is the only ucode TUI.
 *
 * Coverage today: banner, scrolling log via <Static>, tool-call merge with
 * Ctrl+O expand, multiline editor (see MultilineInput.js), spinner+phase
 * status line, abortController-driven Esc cancel, input history Up/Down,
 * agent selection footer, runSingleCommand + runNaturalLanguageTask path.
 *
 * Also covers blessed parity branches: background tasks, ubus, resume,
 * nl_bg, and autoBus polling.
 */

const { runInk } = require("../runInk");
const fmt = require("../format");
const { createMultilineInput } = require("./MultilineInput");

// Throttle for the live thinking-chain status line: rapid thinking_delta
// chunks would otherwise re-render the footer on every SSE event.
const THINKING_STATUS_THROTTLE_MS = 120;

// Log line kinds drive the color treatment of scrollback rows. Kind is pure
// presentation metadata — the stored text never changes.
const LOG_LINE_TEXT_PROPS = {
  user: { color: "green", bold: true },
  assistant: {},
  system: { color: "gray", dimColor: true },
  error: { color: "red" },
  tool: {},
  toolDetail: { color: "gray", dimColor: true },
  bus: { color: "cyan" },
};

// Only assistant prose gets markdown. Error rows are app-generated
// (`Error: …`) and already painted red via resolveLogLineTextProps — running
// them through the MD Error: line rule would wrap chalk ANSI and break the
// plain-text body the Ink color prop expects.
const MARKDOWN_LOG_KINDS = new Set(["assistant"]);

// Resolve a log line kind to ink <Text> props. Unknown/missing kinds (e.g.
// the banner, which already carries chalk ANSI styling) render uncolored.
function resolveLogLineTextProps(kind) {
  return LOG_LINE_TEXT_PROPS[kind] || LOG_LINE_TEXT_PROPS.assistant;
}

function createUcodeApp({ React, ink, props, interactive = true }) {
  const { useEffect, useState, useCallback, useRef } = React;
  const { Box, Text, useInput, useApp, useStdout } = ink;
  const h = React.createElement;
  const MultilineInput = createMultilineInput({ React, ink });

  const banner = fmt.buildUcodeBannerLines({
    model: (props.state && props.state.model) || process.env.UFOO_UCODE_MODEL || "",
    engine: (props.state && props.state.engine) || "ufoo-core",
    workspaceRoot: props.workspaceRoot,
    sessionId: (props.state && props.state.sessionId) || "",
  });

  return function UcodeApp() {
    const [logLines, setLogLines] = useState(() =>
      banner.concat([""]).map((line, idx) => ({ id: `b-${idx}`, text: line }))
    );
    const [draft, setDraft] = useState("");
    const [draftVersion, setDraftVersion] = useState(0);
    // status: idle when message === "". `type` picks a STATUS_INDICATORS
    // bucket; `showTimer` and `startedAt` reproduce the blessed spinner
    // controls. The BG suffix is computed from backgroundTasksRef and
    // appended by computeStatusText below.
    const [status, setStatus] = useState({
      message: "",
      type: "thinking",
      showTimer: false,
      startedAt: 0,
    });
    const [spinnerTick, setSpinnerTick] = useState(0);
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const [agents, setAgents] = useState([]);
    const [selectedAgentIndex, setSelectedAgentIndex] = useState(-1);
    const [agentSelectionMode, setAgentSelectionMode] = useState(false);
    // activeMerge holds the in-flight group of consecutive tool calls.
    // Rendered as a single live row below <Static>; promoted to <Static>
    // and cleared whenever a non-tool log line arrives. lastMergeRef tracks
    // the most recent group with >=2 entries so Ctrl+O can still expand it
    // after the group has been frozen into the log.
    const [activeMerge, setActiveMerge] = useState(null);
    const lastMergeRef = useRef(null);
    // pendingTaskRef holds the live AbortController for the current
    // runNaturalLanguageTask call so Esc can cancel it. We use a ref (not
    // state) because the value is consumed inside the run loop, not by
    // render.
    const pendingTaskRef = useRef(null);
    const backgroundTasksRef = useRef(new Map());
    const backgroundSeqRef = useRef(0);
    const autoBusQueuedRef = useRef(false);
    const autoBusErrorRef = useRef("");
    const [, setBackgroundVersion] = useState(0);
    // inputHistory mirrors blessed's flat history list. Up walks back
    // through it when the editor reports the cursor is already on the top
    // visual row (i.e. moveCursorVertically returned moved=false).
    const [inputHistory, setInputHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(0);
    const [completionIndex, setCompletionIndex] = useState(0);
    const [completionWindowStart, setCompletionWindowStart] = useState(0);
    const [completionSuppressedDraft, setCompletionSuppressedDraft] = useState(null);
    const POPUP_PAGE_SIZE = 8;
    const { exit } = useApp();
    const { stdout } = useStdout();
    const lineSeqRef = useRef(banner.length + 1);
    const mergeIdRef = useRef(0);
    const toolMergeScopeRef = useRef(0);
    // thinkingTailRef accumulates raw thinking_delta text for the live
    // status line; the collapsed tail is pushed through a throttled
    // trailing flush (thinkingTimerRef) so fast streams don't re-render
    // the footer on every chunk.
    const thinkingTailRef = useRef("");
    const thinkingFlushAtRef = useRef(0);
    const thinkingTimerRef = useRef(null);
    // Persist fence/open-code state across streamed assistant log lines so
    // ``` blocks stay styled even when deltas arrive one line at a time.
    const markdownStateRef = useRef({ inCodeBlock: false });

    const targetAgent = agentSelectionMode && selectedAgentIndex >= 0
      ? agents[selectedAgentIndex]
      : null;

    const bumpBackground = useCallback(() => setBackgroundVersion((v) => v + 1), []);

    const getBackgroundSuffix = useCallback(() => {
      const tasks = backgroundTasksRef.current;
      if (!tasks || tasks.size === 0) return "";
      let running = 0;
      let done = 0;
      let failed = 0;
      for (const task of tasks.values()) {
        if (!task) continue;
        if (task.status === "running") running += 1;
        else if (task.status === "done") done += 1;
        else if (task.status === "failed") failed += 1;
      }
      const parts = [];
      if (running) parts.push(`${running} running`);
      if (done) parts.push(`${done} done`);
      if (failed) parts.push(`${failed} failed`);
      return parts.length ? ` · BG ${parts.join("/")}` : "";
    }, []);

    const getAgentLabel = useCallback((agent) => {
      if (!agent) return "";
      if (agent.nickname) return agent.nickname;
      const idTail = String(agent.id || "").slice(0, 6);
      return idTail ? `${agent.type}:${idTail}` : agent.type;
    }, []);

    const ucodeModel = (props.state && props.state.model)
      || process.env.UFOO_UCODE_MODEL
      || "default";
    let workspaceLabel = "";
    try {
      const os = require("os");
      const path = require("path");
      const root = props.workspaceRoot || process.cwd();
      const home = os.homedir();
      let normalized = root.startsWith(home) ? root.replace(home, "~") : root;
      workspaceLabel = path.normalize(normalized);
    } catch {
      workspaceLabel = String(props.workspaceRoot || "");
    }
    const hintParts = [ucodeModel];
    if (workspaceLabel) hintParts.push(workspaceLabel);
    const agentsHint = hintParts.join(" · ");

    const selfSubscriberId = String(
      (props.autoBus && props.autoBus.subscriberId) ||
      process.env.UFOO_SUBSCRIBER_ID ||
      ""
    ).trim();

    const refreshAgents = useCallback(() => {
      try {
        const list = fmt.filterSelectableAgents(
          fmt.loadActiveAgents(props.workspaceRoot),
          selfSubscriberId
        );
        setAgents(list);
      } catch {
        // loadActiveAgents already swallows errors and returns []. This catch
        // is just a belt-and-braces guard against future regressions.
      }
    }, [selfSubscriberId]);

    useEffect(() => {
      if (!interactive) return undefined;
      refreshAgents();
      const timer = setInterval(refreshAgents, 3000);
      return () => clearInterval(timer);
    }, [interactive, refreshAgents]);

    // Keep selection within bounds when the agents list changes.
    useEffect(() => {
      if (selectedAgentIndex < 0) return;
      if (agents.length === 0) {
        setSelectedAgentIndex(-1);
        setAgentSelectionMode(false);
      } else if (selectedAgentIndex >= agents.length) {
        setSelectedAgentIndex(agents.length - 1);
      }
    }, [agents, selectedAgentIndex]);

    const onArrowDownAtEnd = useCallback((currentValue) => {
      // History first: if we're past the bottom of a multi-line edit, walk
      // forward through the recent history. Reaching the end clears the
      // input the same way blessed does.
      if (inputHistory.length > 0) {
        const transition = fmt.resolveHistoryDownTransition({
          inputHistory,
          historyIndex,
          currentValue,
        });
        if (transition.moved) {
          setHistoryIndex(transition.nextHistoryIndex);
          setDraft(transition.nextValue);
          setCompletionSuppressedDraft(transition.nextValue || null);
          setDraftVersion((v) => v + 1);
          return;
        }
      }
      if (agents.length === 0) return;
      const decision = fmt.resolveAgentSelectionOnDown({
        agentSelectionMode,
        selectedAgentIndex,
        totalAgents: agents.length,
      });
      if (decision.action === "enter") {
        setSelectedAgentIndex(decision.index);
        setAgentSelectionMode(true);
      }
    }, [inputHistory, historyIndex, agents, agentSelectionMode, selectedAgentIndex]);

    const onArrowUpAtStart = useCallback((currentValue) => {
      // While @-targeting an agent with an empty draft, Up clears the
      // selection before walking input history — otherwise history eats the
      // key and the ›@agent prefix sticks.
      const inputValue = currentValue != null ? currentValue : draft;
      if (fmt.shouldClearAgentSelectionOnUp({
        agentSelectionMode,
        inputValue,
      })) {
        setAgentSelectionMode(false);
        setSelectedAgentIndex(-1);
        return;
      }
      // History: if we're already on the top visual row, walk back through
      // the recent history before doing anything else.
      if (inputHistory.length > 0) {
        const nextIndex = Math.max(0, historyIndex - 1);
        if (nextIndex !== historyIndex || draft !== inputHistory[nextIndex]) {
          setHistoryIndex(nextIndex);
          const nextValue = inputHistory[nextIndex] || "";
          setDraft(nextValue);
          setCompletionSuppressedDraft(nextValue || null);
          setDraftVersion((v) => v + 1);
        }
      }
    }, [inputHistory, historyIndex, draft, agentSelectionMode]);

    const onArrowSideAtEmpty = useCallback((direction) => {
      if (!agentSelectionMode) return;
      if (agents.length === 0) return;
      const next = fmt.cycleAgentSelectionIndex(
        selectedAgentIndex,
        agents.length,
        direction
      );
      setSelectedAgentIndex(next);
    }, [agents, agentSelectionMode, selectedAgentIndex]);

    const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../../code/commands");
    const { listSessionSummaries } = require("../../code/sessionStore");
    const { suggestUcodeModels, applyUcodeModelCommand } = require("../../code/modelCommand");
    let resumeSessions = [];
    try {
      resumeSessions = listSessionSummaries(props.workspaceRoot || process.cwd(), { limit: 40 });
    } catch {
      resumeSessions = [];
    }
    const modelSuggestions = suggestUcodeModels(props.state || {});

    const completions = fmt.buildCompletions({
      text: draft,
      agents: agents.map((a) => String((a && (a.fullId || a.id || a.nickname)) || "")).filter(Boolean),
      agentLabels: agents.map((a) => getAgentLabel(a)),
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: {
        "/resume": resumeSessions,
        "/model": modelSuggestions,
      },
      limit: 20,
    });
    const completionsOpen = completions.length > 0 && draft !== completionSuppressedDraft;

    useEffect(() => {
      if (completions.length === 0) {
        if (completionIndex !== 0) setCompletionIndex(0);
        if (completionWindowStart !== 0) setCompletionWindowStart(0);
      } else if (completionIndex >= completions.length) {
        setCompletionIndex(completions.length - 1);
        setCompletionWindowStart(Math.max(0, completions.length - POPUP_PAGE_SIZE));
      }
    }, [completions.length, completionIndex, completionWindowStart]);

    const acceptCompletion = useCallback(() => {
      if (!completionsOpen) return false;
      const item = completions[Math.max(0, Math.min(completions.length - 1, completionIndex))];
      if (item) {
        setDraft(item.replace);
        setCompletionSuppressedDraft(item.hasChildren ? null : item.replace);
        setDraftVersion((v) => v + 1);
      }
      setCompletionIndex(0);
      return true;
    }, [completionsOpen, completions, completionIndex]);

    const appendLogLine = useCallback((text, kind = "assistant") => {
      const raw = String(text == null ? "" : text);
      let renderedLines = [raw];
      if (MARKDOWN_LOG_KINDS.has(kind)) {
        try {
          renderedLines = fmt.renderLogLinesWithMarkdownAnsi(raw, markdownStateRef.current);
          if (!Array.isArray(renderedLines) || renderedLines.length === 0) {
            renderedLines = [raw];
          }
        } catch {
          renderedLines = [raw];
        }
      }
      setLogLines((prev) => {
        const next = prev.slice();
        for (const line of renderedLines) {
          const id = `l-${lineSeqRef.current}`;
          lineSeqRef.current += 1;
          next.push({ id, text: String(line || ""), kind });
        }
        return next.length > 1000 ? next.slice(-1000) : next;
      });
    }, []);

    const renderMergeText = useCallback((merge) => {
      if (!merge || !Array.isArray(merge.entries)) return "";
      return fmt.buildToolMergeRowText(merge.entries);
    }, []);

    // Promote the in-flight tool group (if any) to a permanent log line.
    // Called before any non-tool text is logged, so the group "freezes"
    // exactly the way blessed updates the line in place when the next text
    // arrives.
    const flushActiveMerge = useCallback(() => {
      setActiveMerge((current) => {
        if (!current) return null;
        appendLogLine(renderMergeText(current), "tool");
        return null;
      });
    }, [appendLogLine, renderMergeText]);

    const logToolHint = useCallback((entry, payload) => {
      const tool = String((entry && entry.tool) || "").trim().toLowerCase();
      if (!tool) return;
      const resObj = payload && typeof payload === "object" ? payload : (entry && entry.result) || {};
      const phase = String((entry && entry.phase) || "").trim().toLowerCase();
      const isError = phase === "error" || resObj.ok === false;
      const detail = fmt.normalizeToolLogDetail(tool, entry && entry.args, resObj);
      const errorText = String((entry && entry.error) || resObj.error || "").trim();
      const toolEntry = fmt.normalizeToolMergeEntry({ tool, detail, isError, errorText });

      setActiveMerge((current) => {
        const scope = toolMergeScopeRef.current;
        const isNewScope = !(current && current.scope === scope);
        if (isNewScope) {
          mergeIdRef.current += 1;
        }
        const next = fmt.appendToolMergeEntry(current, toolEntry, scope, mergeIdRef.current);
        if (next.entries.length >= 2) lastMergeRef.current = next;
        return next;
      });
    }, []);

    const appendLogText = useCallback((text, kind = "assistant") => {
      // Multi-line text → split into separate log entries so <Static> keys
      // stay stable when streaming arrives line-by-line. Always promote any
      // in-flight tool group first so it freezes above the new text.
      const raw = String(text == null ? "" : text);
      if (!raw) return;
      flushActiveMerge();
      const lines = raw.split(/\r?\n/);
      for (const line of lines) appendLogLine(line, kind);
    }, [appendLogLine, flushActiveMerge]);

    const expandLastMerge = useCallback(() => {
      // Try the active group first; fall back to the most recent frozen one.
      // Both paths must keep the "expand only once" guarantee that blessed
      // enforces via group.expanded.
      const active = activeMerge;
      const candidate = (active && !active.expanded && active.entries.length >= 2)
        ? active
        : (lastMergeRef.current && !lastMergeRef.current.expanded && lastMergeRef.current.entries.length >= 2
            ? lastMergeRef.current
            : null);
      if (!candidate) return;

      const lines = fmt.buildMergedToolExpandedLines(candidate.entries);
      for (let i = 0; i < lines.length; i += 1) {
        const branch = i === lines.length - 1 ? "└" : "│";
        appendLogLine(`${branch} ${lines[i]}`, "toolDetail");
      }
      candidate.expanded = true;
      if (active && active.id === candidate.id) setActiveMerge(null);
      if (lastMergeRef.current && lastMergeRef.current.id === candidate.id) {
        lastMergeRef.current = null;
      }
    }, [activeMerge, appendLogLine]);

    const runChainRef = useRef(Promise.resolve());

    const executeLine = useCallback(async (rawValue) => {
      const normalized = String(rawValue || "").replace(/\r?\n/g, " ").trim();
      if (!normalized) return;
      toolMergeScopeRef.current += 1;
      flushActiveMerge();
      appendLogLine(`› ${normalized}`, "user");

      const runtimeWorkspace = String(
        (props.state && props.state.workspaceRoot) || props.workspaceRoot || process.cwd()
      );

      let result;
      try {
        result = props.runSingleCommand(normalized, runtimeWorkspace);
      } catch (err) {
        appendLogText(`Error: ${err && err.message ? err.message : "command parse failed"}`, "error");
        return;
      }
      if (!result || typeof result !== "object") return;

      switch (result.kind) {
        case "empty":
          return;
        case "exit":
          exit();
          return;
        case "probe":
          return;
        case "help":
        case "error":
          appendLogText(result.output || "");
          return;
        case "status": {
          try {
            const { summarizeSessionUsage, formatSessionUsageStatus } = require("../../code/usageStore");
            const usageSummary = summarizeSessionUsage({
              workspaceRoot: runtimeWorkspace,
              sessionId: (props.state && props.state.sessionId) || "",
            });
            appendLogText(formatSessionUsageStatus(usageSummary), "system");
          } catch (err) {
            appendLogText(`Error: ${err && err.message ? err.message : "status failed"}`, "error");
          }
          return;
        }
        case "model": {
          const applied = applyUcodeModelCommand(props.state || {}, result);
          appendLogText(applied.output || "", applied.ok ? "system" : "error");
          if (applied.ok && result.action === "set" && typeof props.persistSessionState === "function") {
            try {
              const persisted = props.persistSessionState(props.state);
              if (persisted && persisted.ok === false) {
                appendLogText(
                  `Error: failed to persist session ${(props.state && props.state.sessionId) || ""}: ${persisted.error || "unknown error"}`,
                  "error"
                );
              }
            } catch {
              // persist is best-effort after a successful model switch
            }
          }
          return;
        }
        case "ubus": {
          setStatus({ message: "Checking bus messages...", type: "typing", showTimer: false, startedAt: Date.now() });
          try {
            const { extractAgentNickname } = require("../../code/agent");
            const ubusResult = await props.runUbusCommand(props.state, {
              workspaceRoot: runtimeWorkspace,
              onMessageReceived: (msg) => {
                const nickname = extractAgentNickname(msg && msg.from) || (msg && msg.from) || "bus";
                appendLogText(`${nickname}: ${(msg && msg.task) || ""}`, "bus");
              },
            });
            if (!ubusResult || !ubusResult.ok) {
              appendLogText(`Error: ${(ubusResult && ubusResult.error) || "ubus failed"}`, "error");
              return;
            }
            const exchanges = Array.isArray(ubusResult.messageExchanges) ? ubusResult.messageExchanges : [];
            if (exchanges.length > 0) {
              for (const exchange of exchanges) {
                const nickname = extractAgentNickname(exchange && exchange.from) || (exchange && exchange.from) || "bus";
                appendLogText(`@${nickname} ${(exchange && exchange.reply) || ""}`, "bus");
              }
            } else if (Number(ubusResult.handled) === 0) {
              appendLogText("ubus: no pending messages.", "system");
            }
            if (typeof props.persistSessionState === "function") {
              const persisted = props.persistSessionState(props.state);
              if (!persisted || persisted.ok === false) {
                appendLogText(`Error: failed to persist session ${(props.state && props.state.sessionId) || ""}: ${(persisted && persisted.error) || "unknown error"}`, "error");
              }
            }
          } finally {
            setStatus({ message: "", type: "thinking", showTimer: false, startedAt: 0 });
          }
          return;
        }
        case "resume": {
          if (typeof props.resumeSessionState !== "function") {
            appendLogText("Error: resume unsupported", "error");
            return;
          }
          const resumed = props.resumeSessionState(props.state, result.sessionId, runtimeWorkspace);
          if (!resumed || !resumed.ok) {
            appendLogText(`Error: ${(resumed && resumed.error) || "resume failed"}`, "error");
            return;
          }
          // Rebuild the visible log from the restored session transcript so
          // the user sees prior turns instead of only a status toast.
          markdownStateRef.current = { inCodeBlock: false };
          const history = fmt.buildUcodeSessionLogEntries(
            Array.isArray(props.state && props.state.nlMessages) ? props.state.nlMessages : [],
            { markdownState: markdownStateRef.current, idPrefix: "h", startSeq: 0 },
          );
          const bannerEntries = banner.concat([""]).map((line, idx) => ({
            id: `b-${idx}`,
            text: line,
          }));
          const notice = {
            id: `h-resume-${Date.now().toString(36)}`,
            text: `Resumed session ${resumed.sessionId} (${resumed.restoredMessages} messages).`,
            kind: "system",
          };
          const nextLines = bannerEntries.concat(history.entries).concat([notice]);
          setLogLines(nextLines.length > 1000 ? nextLines.slice(-1000) : nextLines);
          lineSeqRef.current = Math.max(
            bannerEntries.length + 1,
            Number(history.nextSeq) || 0,
            nextLines.length,
          );
          setActiveMerge(null);
          lastMergeRef.current = null;
          return;
        }
        case "tool": {
          const payload = result.result && typeof result.result === "object" ? result.result : {};
          logToolHint({
            tool: result.tool,
            args: result.args,
            phase: payload.ok === false ? "error" : "end",
            error: payload.error || "",
          }, payload);
          return;
        }
        case "nl_bg": {
          backgroundSeqRef.current += 1;
          const jobId = `bg-${Date.now().toString(36)}-${backgroundSeqRef.current.toString(36)}`;
          const taskRecord = {
            id: jobId,
            task: result.task,
            status: "running",
            startedAt: Date.now(),
            summary: "",
          };
          backgroundTasksRef.current.set(jobId, taskRecord);
          bumpBackground();
          setStatus({ message: "", type: "thinking", showTimer: false, startedAt: 0 });
          appendLogText(`[${jobId}] started in background.`, "system");

          const bgState = {
            workspaceRoot: props.state && props.state.workspaceRoot,
            provider: props.state && props.state.provider,
            model: props.state && props.state.model,
            engine: props.state && props.state.engine,
            context: props.state && props.state.context,
            nlMessages: Array.isArray(props.state && props.state.nlMessages) ? props.state.nlMessages.slice() : [],
            sessionId: "",
            timeoutMs: props.state && props.state.timeoutMs,
            jsonOutput: false,
          };

          Promise.resolve()
            .then(() => props.runNaturalLanguageTask(result.task, bgState))
            .then((nlResult) => {
              taskRecord.status = nlResult && nlResult.ok ? "done" : "failed";
              taskRecord.finishedAt = Date.now();
              taskRecord.summary = String(props.formatNlResult(nlResult, false) || "").trim();
              const title = taskRecord.status === "done" ? "done" : "failed";
              appendLogText(`[${jobId}] ${title}: ${taskRecord.summary || "no summary"}`, "system");
            })
            .catch((err) => {
              taskRecord.status = "failed";
              taskRecord.finishedAt = Date.now();
              taskRecord.summary = err && err.message ? String(err.message) : "background task failed";
              appendLogText(`[${jobId}] failed: ${taskRecord.summary}`, "system");
            })
            .finally(() => {
              bumpBackground();
              setStatus({ message: "", type: "thinking", showTimer: false, startedAt: 0 });
            });
          return;
        }
        case "nl": {
          const startedAt = Date.now();
          const abortController = new AbortController();
          pendingTaskRef.current = { abortController, startedAt };
          const setNlStatus = (msg) => setStatus({
            message: msg,
            type: "thinking",
            showTimer: true,
            startedAt,
          });
          const cancelThinkingFlush = () => {
            if (thinkingTimerRef.current) {
              clearTimeout(thinkingTimerRef.current);
              thinkingTimerRef.current = null;
            }
          };
          const flushThinkingStatus = () => {
            thinkingFlushAtRef.current = Date.now();
            setNlStatus(collapseThinkingTail(thinkingTailRef.current) || "Thinking...");
          };
          setNlStatus("Waiting for model...");
          let streamBuf = "";
          let sawStreamText = false;
          let streamStarted = false;
          let dropLeadingStreamBlank = false;
          let nlResult = null;
          try {
            nlResult = await props.runNaturalLanguageTask(result.task, props.state, {
              signal: abortController.signal,
              onPhase: (event) => {
                if (!event || typeof event !== "object") return;
                if (event.type === "request_start") {
                  cancelThinkingFlush();
                  setNlStatus("Waiting for model...");
                } else if (event.type === "thinking_delta") {
                  thinkingTailRef.current += String(event.text || "");
                  const elapsed = Date.now() - thinkingFlushAtRef.current;
                  if (elapsed >= THINKING_STATUS_THROTTLE_MS) {
                    cancelThinkingFlush();
                    flushThinkingStatus();
                  } else if (!thinkingTimerRef.current) {
                    // Trailing flush guarantees the final tail lands even
                    // when the stream ends inside a throttle window.
                    thinkingTimerRef.current = setTimeout(() => {
                      thinkingTimerRef.current = null;
                      flushThinkingStatus();
                    }, THINKING_STATUS_THROTTLE_MS - elapsed);
                  }
                } else if (event.type === "text_delta") {
                  cancelThinkingFlush();
                  setNlStatus("Generating response...");
                } else if (event.type === "tool_request") {
                  cancelThinkingFlush();
                  const label = fmt.TOOL_LABELS[String(event.name || "").toLowerCase()] ||
                    `Calling ${event.name}`;
                  setNlStatus(`${label}...`);
                }
              },
              onDelta: (delta) => {
                const text = String(delta || "");
                if (!text) return;
                if (!streamStarted) {
                  flushActiveMerge();
                  streamStarted = true;
                }
                const split = fmt.splitStreamingLogChunk(streamBuf, text, {
                  dropLeadingBlank: dropLeadingStreamBlank,
                });
                if (split.sawVisible) {
                  sawStreamText = true;
                  dropLeadingStreamBlank = false;
                }
                for (const line of split.lines) {
                  appendLogLine(line);
                }
                streamBuf = split.buffer;
              },
              onToolLog: (entry) => {
                if (!entry || typeof entry !== "object") return;
                if (entry.tool && entry.phase === "start") {
                  const label = fmt.TOOL_LABELS[String(entry.tool || "").toLowerCase()] ||
                    `Calling ${entry.tool}`;
                  setNlStatus(`${label}...`);
                  dropLeadingStreamBlank = true;
                }
                logToolHint(entry, entry.result);
              },
            });
          } catch (err) {
            appendLogText(`Error: ${err && err.message ? err.message : "agent loop failed"}`, "error");
            return;
          } finally {
            pendingTaskRef.current = null;
            cancelThinkingFlush();
            thinkingTailRef.current = "";
            setStatus({ message: "", type: "thinking", showTimer: false, startedAt: 0 });
          }
          if (streamBuf) {
            if (/[^\s]/.test(streamBuf)) sawStreamText = true;
            appendLogLine(streamBuf);
          }
          // Skip the summary echo when the model already streamed its
          // response in full — otherwise the user sees the same text twice.
          // Mirrors the shouldSkipSummary check in tui.js.
          const streamed = Boolean(nlResult && nlResult.streamed);
          const ok = Boolean(nlResult && nlResult.ok);
          const shouldSkipSummary = streamed && ok && sawStreamText;
          if (!shouldSkipSummary) {
            const summary = props.formatNlResult(nlResult, false);
            if (summary) appendLogText(summary);
          }
          flushActiveMerge();
          try {
            const persisted = props.persistSessionState(props.state);
            if (persisted && persisted.ok === false) {
              appendLogText(
                `Error: failed to persist session ${(props.state && props.state.sessionId) || ""}: ${persisted.error || "unknown error"}`,
                "error"
              );
            }
          } catch {
            // persistSessionState failures shouldn't crash the TUI.
          }
          return;
        }
        default:
          if (result.output) appendLogText(result.output);
      }
    }, [appendLogLine, appendLogText, exit, props, logToolHint, flushActiveMerge]);
    // ^ `props` is captured by the createUcodeApp closure on a single mount,
    // so its reference is stable across renders even though it looks like a
    // changing dep to React's exhaustive-deps lint.

    const runAutoBusOnce = useCallback(async () => {
      const autoBus = props.autoBus || {};
      if (!autoBus.enabled || pendingTaskRef.current) return;
      const getPendingCount = typeof autoBus.getPendingCount === "function"
        ? autoBus.getPendingCount
        : () => 0;
      if (Number(getPendingCount()) <= 0) {
        autoBusErrorRef.current = "";
        return;
      }

      const abortController = new AbortController();
      const startedAt = Date.now();
      pendingTaskRef.current = { abortController, startedAt };
      setStatus({
        message: "Processing bus messages...",
        type: "thinking",
        showTimer: true,
        startedAt,
      });

      try {
        const { extractAgentNickname } = require("../../code/agent");
        const ubusResult = await props.runUbusCommand(props.state, {
          workspaceRoot: props.workspaceRoot,
          subscriberId: autoBus.subscriberId,
          signal: abortController.signal,
          onMessageReceived: (msg) => {
            const nickname = extractAgentNickname(msg && msg.from) || (msg && msg.from) || "bus";
            appendLogText(`${nickname}: ${(msg && msg.task) || ""}`, "bus");
            setStatus({
              message: "Working on task...",
              type: "thinking",
              showTimer: true,
              startedAt,
            });
          },
        });

        if (!ubusResult || !ubusResult.ok) {
          const nextError = String((ubusResult && ubusResult.error) || "ubus failed");
          if (nextError !== autoBusErrorRef.current) {
            autoBusErrorRef.current = nextError;
            appendLogText(`Error: ${nextError}`, "error");
          }
          return;
        }

        autoBusErrorRef.current = "";
        const exchanges = Array.isArray(ubusResult.messageExchanges) ? ubusResult.messageExchanges : [];
        for (const exchange of exchanges) {
          const nickname = extractAgentNickname(exchange && exchange.from) || (exchange && exchange.from) || "bus";
          appendLogText(`@${nickname} ${(exchange && exchange.reply) || ""}`, "bus");
        }
        if (Number(ubusResult.handled) > 0 && typeof props.persistSessionState === "function") {
          const persisted = props.persistSessionState(props.state);
          if (!persisted || persisted.ok === false) {
            appendLogText(`Error: failed to persist session ${(props.state && props.state.sessionId) || ""}: ${(persisted && persisted.error) || "unknown error"}`, "error");
          }
        }
      } finally {
        pendingTaskRef.current = null;
        setStatus({ message: "", type: "thinking", showTimer: false, startedAt: 0 });
      }
    }, [appendLogText, props]);

    useEffect(() => {
      if (!interactive || !(props.autoBus && props.autoBus.enabled)) return undefined;
      const schedule = () => {
        if (autoBusQueuedRef.current || pendingTaskRef.current) return;
        const getPendingCount = typeof props.autoBus.getPendingCount === "function"
          ? props.autoBus.getPendingCount
          : () => 0;
        if (Number(getPendingCount()) <= 0) return;
        autoBusQueuedRef.current = true;
        runChainRef.current = runChainRef.current
          .then(() => runAutoBusOnce())
          .catch((err) => appendLogText(`Error: ${err && err.message ? err.message : "ubus failed"}`, "error"))
          .finally(() => {
            autoBusQueuedRef.current = false;
          });
      };
      const timer = setInterval(schedule, 1500);
      schedule();
      return () => clearInterval(timer);
    }, [interactive, props.autoBus, runAutoBusOnce, appendLogText]);

    const submit = useCallback((submitted) => {
      const value = String(submitted == null ? draft : submitted);
      const trimmed = value.trim();
      if (!trimmed) return;
      setDraft("");
      setDraftVersion((v) => v + 1);
      setInputHistory((prev) => {
        const next = prev.concat([trimmed]).slice(-200);
        setHistoryIndex(next.length);
        return next;
      });
      // Serialize executions so streaming tasks don't interleave.
      runChainRef.current = runChainRef.current
        .then(() => executeLine(value))
        .catch((err) => appendLogText(`Error: ${err && err.message ? err.message : err}`, "error"));
    }, [draft, executeLine, appendLogText]);

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () => {
        const next = { cols: stdout.columns || 0, rows: stdout.rows || 0 };
        setSize((prev) => (prev.cols === next.cols && prev.rows === next.rows ? prev : next));
      };
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    // Drive the spinner + elapsed-timer redraws while a task is in flight.
    useEffect(() => {
      const statusType = inferStatusType(status.message, status.type);
      if (!status.message || statusType === "none" || statusType === "idle" ||
        statusType === "done" || statusType === "success" || statusType === "error") {
        return undefined;
      }
      const timer = setInterval(() => {
        setSpinnerTick((t) => t + 1);
      }, 100);
      return () => clearInterval(timer);
    }, [status.message, status.type, status.showTimer]);

    const statusText = useMemoStatusText(React, status, spinnerTick, getBackgroundSuffix());

    // Top-level catches Ctrl+C / Ctrl+O, plus completion popup navigation
    // while a slash/agent menu is open.
    useInput((input, key) => {
      if (key.ctrl && input === "c") { exit(); return; }
      if (key.ctrl && input === "o") { expandLastMerge(); return; }
      if (!completionsOpen) return;
      if (key.upArrow) {
        setCompletionIndex((i) => {
          const next = (i - 1 + completions.length) % completions.length;
          setCompletionWindowStart((ws) => {
            if (next < ws) return next;
            if (next === completions.length - 1) {
              return Math.max(0, completions.length - POPUP_PAGE_SIZE);
            }
            return ws;
          });
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setCompletionIndex((i) => {
          const next = (i + 1) % completions.length;
          setCompletionWindowStart((ws) => {
            if (next === 0) return 0;
            if (next >= ws + POPUP_PAGE_SIZE) return next - POPUP_PAGE_SIZE + 1;
            return ws;
          });
          return next;
        });
        return;
      }
      if (key.return) {
        // Leaf completions (e.g. /resume <session>) run immediately on Enter.
        // Parents with children only fill the draft so the next menu can open.
        const item = completions[Math.max(0, Math.min(completions.length - 1, completionIndex))];
        if (item && !item.hasChildren) {
          const cmd = String(item.replace || "").trim();
          setCompletionIndex(0);
          setCompletionSuppressedDraft(null);
          if (cmd) submit(cmd);
          return;
        }
        acceptCompletion();
        return;
      }
      if (key.tab) {
        acceptCompletion();
        return;
      }
      if (key.escape) {
        setCompletionSuppressedDraft(null);
        setDraft("");
        setDraftVersion((v) => v + 1);
      }
    }, { isActive: interactive });

    return h(Box, { flexDirection: "column", width: "100%" },
      h(Box, { flexDirection: "column", width: "100%" },
        ...(() => {
          // Re-render raw markdown at paint time so leftover ** / ### from
          // older append paths or nested `**code**` patterns still resolve.
          const mdState = { inCodeBlock: false };
          return logLines.map((item, idx) => {
            let text = item.text || " ";
            if (MARKDOWN_LOG_KINDS.has(item.kind) && /(?:\*\*|__|^\s*#{1,6}\s|^\s*`{3})/m.test(text)) {
              try {
                const rendered = fmt.renderLogLinesWithMarkdownAnsi(text, mdState);
                if (Array.isArray(rendered) && rendered.length > 0) {
                  text = rendered.length === 1 ? rendered[0] : rendered.join("\n");
                }
              } catch {
                // keep original
              }
            } else if (MARKDOWN_LOG_KINDS.has(item.kind) && mdState.inCodeBlock) {
              try {
                const rendered = fmt.renderLogLinesWithMarkdownAnsi(text, mdState);
                if (Array.isArray(rendered) && rendered[0] != null) text = rendered[0];
              } catch {
                // keep original
              }
            }
            const textEl = h(Text, { ...resolveLogLineTextProps(item.kind) }, text || " ");
            // Give user turns a blank line above/below so › prompts don't
            // sit flush against system/tool rows. Multi-line user blocks
            // only pad the outer edges.
            if (item.kind === "user") {
              const prev = logLines[idx - 1];
              const next = logLines[idx + 1];
              const marginTop = !prev || prev.kind !== "user" ? 1 : 0;
              const marginBottom = !next || next.kind !== "user" ? 1 : 0;
              return h(Box, {
                key: item.id,
                width: "100%",
                marginTop,
                marginBottom,
              }, textEl);
            }
            return h(Text, { key: item.id, ...resolveLogLineTextProps(item.kind) }, text || " ");
          });
        })()
      ),
      activeMerge ? h(Box, null,
        h(Text, { color: activeMerge.entries.some((e) => e.isError) ? "red" : "cyan" },
          renderMergeText(activeMerge)
        ),
      ) : null,
      h(Box, { marginTop: 1, width: "100%" },
        h(Text, { color: "gray" }, statusText),
        h(Box, { flexGrow: 1 }),
        h(Text, { color: "gray" }, `v${fmt.UCODE_VERSION}`),
      ),
      completionsOpen ? (() => {
        const start = Math.min(completionWindowStart, Math.max(0, completions.length - POPUP_PAGE_SIZE));
        const end = Math.min(completions.length, start + POPUP_PAGE_SIZE);
        const visible = completions.slice(start, end);
        const cols = Math.max(8, size.cols || 80);
        // Frame the popup with a top rule; MultilineInput's borderTop is the
        // matching bottom rule, so we intentionally omit a trailing ─ here.
        return h(Box, { flexDirection: "column", width: "100%" },
          h(Text, { color: "gray" }, "─".repeat(cols)),
          ...visible.map((s, idxInWindow) => {
            const idx = start + idxInWindow;
            const selected = idx === completionIndex;
            // Keep label+description in one Text. Splitting into sibling
            // Text nodes with wrap:"truncate" lets Yoga shrink the label
            // and mid-cut commands (e.g. "/help" → "/he p").
            const line = s.description
              ? `${s.label}  ${s.description}`
              : String(s.label || "");
            return h(Box, { key: `cmp-${idx}`, width: "100%" },
              h(Text, {
                color: selected ? "cyan" : "gray",
                inverse: selected,
                wrap: "truncate",
              }, line),
            );
          }),
        );
      })() : null,
      h(Box, { width: "100%" },
        h(MultilineInput, {
          value: draft,
          valueVersion: draftVersion,
          onChange: (next) => {
            if (completionSuppressedDraft !== null && next !== completionSuppressedDraft) {
              setCompletionSuppressedDraft(null);
            }
            setDraft(next);
          },
          onSubmit: (value) => {
            setCompletionSuppressedDraft(null);
            submit(value);
          },
          onCancel: () => {
            if (completionsOpen) {
              setCompletionSuppressedDraft(null);
              setDraft("");
              setDraftVersion((v) => v + 1);
              return;
            }
            // If a task is in flight, Esc requests cancellation. Otherwise
            // it clears the agent selection (matches blessed). The text
            // value is left alone so the user doesn't lose what they typed.
            const pending = pendingTaskRef.current;
            if (pending && pending.abortController && !pending.abortController.signal.aborted) {
              try { pending.abortController.abort(); } catch { /* ignore */ }
              appendLogLine("⚙ Cancellation requested. Stopping the current task...", "system");
              setStatus({
                message: "Cancelling...",
                type: "waiting",
                showTimer: true,
                startedAt: pending.startedAt,
              });
              return;
            }
            if (agentSelectionMode) {
              setAgentSelectionMode(false);
              setSelectedAgentIndex(-1);
            }
          },
          onArrowDownAtBottom: onArrowDownAtEnd,
          onArrowUpAtTop: onArrowUpAtStart,
          onArrowLeftAtEmpty: () => onArrowSideAtEmpty("left"),
          onArrowRightAtEmpty: () => onArrowSideAtEmpty("right"),
          width: Math.max(20, (size.cols || 80) - 4),
          interactive,
          interceptArrowsAndEnter: completionsOpen,
          placeholder: "",
          promptPrefix: targetAgent ? `›@${getAgentLabel(targetAgent)} ` : "› ",
          // Completions render ABOVE the input. Only the Agents footer is
          // below — counting popup rows here parks the hardware cursor up
          // into the menu (ghost block on /status etc.).
          linesBelowInput: 1,
          // During model/tool activity ucode redraws the status line every
          // spinner frame. Keeping the hardware cursor hidden avoids a
          // visible hide/show flash; the inverse caret remains rendered and
          // the cursor position is still parked for IME composition.
          showHardwareCursor: !status.message,
        }),
      ),
      h(Box, { width: "100%" },
        h(Text, { wrap: "truncate", color: "gray" }, "Agents: "),
        agents.length === 0
          ? h(Text, { wrap: "truncate", color: "cyan" }, "none")
          : (() => {
              const labels = agents.map((a) => `@${getAgentLabel(a)}`);
              // Reserve 1 col for borders, the "Agents: " prefix, the hint
              // and a few spaces for safety. We just clamp aggressively
              // when stdout.cols is unknown.
              const cols = size.cols || 80;
              const reservedForHint = fmt.displayCellWidth(` · ${agentsHint}`);
              const budget = Math.max(20, cols - 10 - reservedForHint);
              const plan = fmt.planAgentsFooter(
                labels,
                agentSelectionMode ? selectedAgentIndex : -1,
                budget
              );
              return h(React.Fragment, null,
                ...plan.items.map((item, idx) =>
                  h(React.Fragment, { key: idx },
                    idx > 0 ? h(Text, { color: "gray" }, " ") : null,
                    h(Text, {
                      wrap: "truncate",
                      color: item.selected ? undefined : "cyan",
                      inverse: item.selected,
                    }, item.label),
                  )
                ),
                plan.hint
                  ? h(Text, { wrap: "truncate", color: "gray" }, plan.hint)
                  : null,
              );
            })(),
        h(Text, { wrap: "truncate", color: "gray" }, ` · ${agentsHint}`),
      ),
    );
  };
}

function runUcodeInkTui(props = {}) {
  return new Promise((resolve, reject) => {
    runInk(
      (React, ink) => {
        const UcodeApp = createUcodeApp({ React, ink, props });
        return React.createElement(UcodeApp);
      },
      {
        stdin: props.stdin || process.stdin,
        stdout: props.stdout || process.stdout,
        exitOnCtrlC: true,
      }
    )
      .then(async (handle) => {
        try {
          await handle.waitUntilExit();
          resolve({ code: 0 });
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

module.exports = { runUcodeInkTui, createUcodeApp, computeStatusText, collapseThinkingTail, resolveLogLineTextProps };

function inferStatusType(text = "", requestedType = "") {
  const type = String(requestedType || "").trim().toLowerCase();
  if (type === "done" || type === "success" || type === "error" || type === "idle" || type === "none") {
    return type;
  }
  const clean = String(text || "").trim();
  if (/^[✗!]/.test(clean) || /\b(error|failed|failure)\b/i.test(clean) || /失败|错误/.test(clean)) return "error";
  if (
    /^[✓✔]/.test(clean) ||
    /^(done|complete|completed|finished|success|succeeded|ready)\b/i.test(clean) ||
    /\bdone\s*$/i.test(clean) ||
    /完成|成功/.test(clean)
  ) return "done";
  return type || "thinking";
}

/**
 * Pure status-line text builder used by the React component (and unit
 * tests). Returns "UCODE · Ready" while idle and a spinner+message+timer
 * combination while a task is in flight, mirroring updateStatus() in the
 * blessed implementation.
 */
function collapseThinkingTail(text, maxChars = 80) {
  const collapsed = String(text || "").replace(/\s+/g, " ").trim();
  const parsed = Number(maxChars);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 80;
  if (!collapsed) return "";

  // Prefer the latest markdown emphasis / section so the status line shows the
  // current thought instead of a mid-word tail of an earlier heading.
  let candidate = collapsed;
  const boldParts = collapsed.match(/\*\*[^*]+\*\*/g);
  if (boldParts && boldParts.length > 0) {
    candidate = boldParts[boldParts.length - 1].replace(/\*/g, "").trim() || candidate;
  } else {
    const clauses = collapsed.split(/(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
    if (clauses.length > 1) candidate = clauses[clauses.length - 1];
  }

  if (candidate.length <= limit) return candidate;
  return `…${candidate.slice(-(limit - 1))}`;
}

function computeStatusText(status, spinnerTick, backgroundSuffix = "") {
  const message = String((status && status.message) || "");
  const suffix = String(backgroundSuffix || "");
  if (!message) return `UCODE · Ready${suffix}`;
  const type = inferStatusType(message, status && status.type);
  if (type === "done" || type === "success") {
    const clean = message.trim();
    return `${/^[✓✔]/.test(clean) ? clean : `✓ ${clean}`}${suffix}`;
  }
  if (type === "error") {
    const clean = message.trim();
    return `${/^[✗!]/.test(clean) ? clean : `✗ ${clean}`}${suffix}`;
  }
  if (type === "idle" || type === "none") return `${message.trim() || "UCODE · Ready"}${suffix}`;
  const indicators = fmt.STATUS_INDICATORS[type] || fmt.STATUS_INDICATORS.thinking;
  const indicator = indicators[Math.max(0, Math.floor(Number(spinnerTick) || 0)) % indicators.length];
  const startedAt = Number.isFinite(status && status.startedAt) ? status.startedAt : 0;
  const timerText = status && status.showTimer && startedAt
    ? ` (${fmt.formatPendingElapsed(Date.now() - startedAt)}, esc cancel)`
    : "";
  return `${indicator} ${message}${timerText}${suffix}`;
}

function useMemoStatusText(React, status, spinnerTick, backgroundSuffix = "") {
  // Dependencies intentionally include startedAt so the timer ticks even
  // when the message string is unchanged.
  return React.useMemo(
    () => computeStatusText(status, spinnerTick, backgroundSuffix),
    [status, spinnerTick, backgroundSuffix]
  );
}
