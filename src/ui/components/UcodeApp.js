"use strict";

/**
 * Ink-based ucode TUI. Behaviourally equivalent to runUcodeBlessedTui in
 * src/code/tui.js but rendered via React + ink.
 *
 * Activation: set UFOO_TUI=ink. The blessed path remains the default until
 * P1 is signed off and we flip the switch.
 *
 * This file currently only ships the layout shell (banner, log, status,
 * input). Runner wiring and tool-call merging land in P1.4.
 */

const { runInk } = require("../runInk");
const fmt = require("../format");
const { createMultilineInput } = require("./MultilineInput");

function createUcodeApp({ React, ink, props, interactive = true }) {
  const { useEffect, useState, useCallback, useRef } = React;
  const { Box, Text, Static, useInput, useApp, useStdout } = ink;
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
    // status: idle when message === "". `type` picks a STATUS_INDICATORS
    // bucket; `showTimer` and `startedAt` reproduce the blessed spinner
    // controls. P1.4d will append a "BG x/y/z" suffix when background
    // tasks land.
    const [status, setStatus] = useState({
      message: "",
      type: "thinking",
      showTimer: false,
      startedAt: 0,
    });
    const [spinnerTick, setSpinnerTick] = useState(0);
    const [, setNowTick] = useState(0);
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
    const { exit } = useApp();
    const { stdout } = useStdout();
    const lineSeqRef = useRef(banner.length + 1);
    const mergeIdRef = useRef(0);

    const targetAgent = agentSelectionMode && selectedAgentIndex >= 0
      ? agents[selectedAgentIndex]
      : null;

    const getAgentLabel = useCallback((agent) => {
      if (!agent) return "";
      if (agent.nickname) return agent.nickname;
      const idTail = String(agent.id || "").slice(0, 6);
      return idTail ? `${agent.type}:${idTail}` : agent.type;
    }, []);

    const agentsHint = agents.length === 0
      ? "No target agents"
      : (targetAgent
          ? `↓ select ${getAgentLabel(targetAgent)} · ←/→ switch · ↑ clear`
          : "↓ select target · ←/→ switch");

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

    const onArrowDownAtEnd = useCallback(() => {
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
      // 'hold' is a no-op (already in selection mode).
    }, [agents, agentSelectionMode, selectedAgentIndex]);

    const onArrowUpAtStart = useCallback(() => {
      if (agentSelectionMode) {
        setAgentSelectionMode(false);
        setSelectedAgentIndex(-1);
      }
    }, [agentSelectionMode]);

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

    const appendLogLine = useCallback((text) => {
      setLogLines((prev) => {
        const id = `l-${lineSeqRef.current}`;
        lineSeqRef.current += 1;
        const next = prev.concat([{ id, text: String(text || "") }]);
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
        appendLogLine(renderMergeText(current));
        return null;
      });
    }, [appendLogLine, renderMergeText]);

    const logToolHint = useCallback((entry, payload) => {
      const tool = String((entry && entry.tool) || "").trim().toLowerCase();
      if (!tool) return;
      const resObj = payload && typeof payload === "object" ? payload : (entry && entry.result) || {};
      const phase = String((entry && entry.phase) || "").trim().toLowerCase();
      const isError = phase === "error" || resObj.ok === false;
      const detail = tool === "bash" ? fmt.normalizeBashToolCommand(entry && entry.args, resObj) : "";
      const errorText = String((entry && entry.error) || resObj.error || "").trim();
      const toolEntry = fmt.normalizeToolMergeEntry({ tool, detail, isError, errorText });

      setActiveMerge((current) => {
        let next;
        if (current) {
          next = { ...current, entries: current.entries.concat([toolEntry]) };
        } else {
          mergeIdRef.current += 1;
          next = { id: mergeIdRef.current, entries: [toolEntry], expanded: false };
        }
        if (next.entries.length >= 2) lastMergeRef.current = next;
        return next;
      });
    }, []);

    const appendLogText = useCallback((text) => {
      // Multi-line text → split into separate log entries so <Static> keys
      // stay stable when streaming arrives line-by-line. Always promote any
      // in-flight tool group first so it freezes above the new text.
      const raw = String(text == null ? "" : text);
      if (!raw) return;
      flushActiveMerge();
      const lines = raw.split(/\r?\n/);
      for (const line of lines) appendLogLine(line);
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
        appendLogLine(`${branch} ${lines[i]}`);
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
      appendLogLine(`› ${normalized}`);

      const runtimeWorkspace = String(
        (props.state && props.state.workspaceRoot) || props.workspaceRoot || process.cwd()
      );

      let result;
      try {
        result = props.runSingleCommand(normalized, runtimeWorkspace);
      } catch (err) {
        appendLogText(`Error: ${err && err.message ? err.message : "command parse failed"}`);
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
        case "nl": {
          const startedAt = Date.now();
          const setNlStatus = (msg) => setStatus({
            message: msg,
            type: "thinking",
            showTimer: true,
            startedAt,
          });
          setNlStatus("Waiting for model...");
          let streamBuf = "";
          let sawStreamText = false;
          let nlResult = null;
          try {
            nlResult = await props.runNaturalLanguageTask(result.task, props.state, {
              onPhase: (event) => {
                if (!event || typeof event !== "object") return;
                if (event.type === "request_start") setNlStatus("Waiting for model...");
                else if (event.type === "thinking_delta") setNlStatus("Thinking...");
                else if (event.type === "text_delta") setNlStatus("Generating response...");
                else if (event.type === "tool_request") {
                  const label = fmt.TOOL_LABELS[String(event.name || "").toLowerCase()] ||
                    `Calling ${event.name}`;
                  setNlStatus(`${label}...`);
                }
              },
              onDelta: (delta) => {
                const text = String(delta || "");
                if (!text) return;
                if (/[^\s]/.test(text)) sawStreamText = true;
                streamBuf += text;
                const parts = streamBuf.split(/\r?\n/);
                while (parts.length > 1) {
                  appendLogLine(parts.shift());
                }
                streamBuf = parts[0];
              },
              onToolLog: (entry) => {
                if (!entry || typeof entry !== "object") return;
                if (entry.tool && entry.phase === "start") {
                  const label = fmt.TOOL_LABELS[String(entry.tool || "").toLowerCase()] ||
                    `Calling ${entry.tool}`;
                  setNlStatus(`${label}...`);
                }
                logToolHint(entry, entry.result);
              },
            });
          } catch (err) {
            appendLogText(`Error: ${err && err.message ? err.message : "agent loop failed"}`);
            return;
          } finally {
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
          try {
            const persisted = props.persistSessionState(props.state);
            if (persisted && persisted.ok === false) {
              appendLogText(
                `Error: failed to persist session ${(props.state && props.state.sessionId) || ""}: ${persisted.error || "unknown error"}`
              );
            }
          } catch {
            // persistSessionState failures shouldn't crash the TUI.
          }
          return;
        }
        default:
          // ubus / resume / nl_bg etc. — wired in later P1.4 sub-tasks.
          if (result.output) appendLogText(result.output);
      }
    }, [appendLogLine, appendLogText, exit, props]);

    const submit = useCallback((submitted) => {
      const value = String(submitted == null ? draft : submitted);
      const trimmed = value.trim();
      if (!trimmed) return;
      setDraft("");
      // Serialize executions so streaming tasks don't interleave.
      runChainRef.current = runChainRef.current
        .then(() => executeLine(value))
        .catch((err) => appendLogText(`Error: ${err && err.message ? err.message : err}`));
    }, [draft, executeLine, appendLogText]);

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () =>
        setSize({ cols: stdout.columns || 0, rows: stdout.rows || 0 });
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    // Drive the spinner + elapsed-timer redraws while a task is in flight.
    useEffect(() => {
      if (!status.message || status.type === "none") return undefined;
      const timer = setInterval(() => {
        setSpinnerTick((t) => t + 1);
        if (status.showTimer) setNowTick((t) => t + 1);
      }, 100);
      return () => clearInterval(timer);
    }, [status.message, status.type, status.showTimer]);

    const statusText = useMemoStatusText(React, status, spinnerTick);

    // Top-level only catches Ctrl+C and Ctrl+O (expand last tool group);
    // the editor handles all text editing.
    useInput((input, key) => {
      if (key.ctrl && input === "c") { exit(); return; }
      if (key.ctrl && input === "o") { expandLastMerge(); return; }
    }, { isActive: interactive });

    return h(Box, { flexDirection: "column", width: "100%" },
      h(Static, { items: logLines }, (item) =>
        h(Text, { key: item.id }, item.text || " ")
      ),
      activeMerge ? h(Box, null,
        h(Text, { color: activeMerge.entries.some((e) => e.isError) ? "red" : "cyan" },
          renderMergeText(activeMerge)
        ),
      ) : null,
      h(Box, { marginTop: 1 },
        h(Text, { color: "gray" }, statusText),
        size.cols > 0 ? h(Text, { color: "gray" }, ` · ${size.cols}x${size.rows}`) : null,
      ),
      h(Box, { width: "100%" },
        h(MultilineInput, {
          value: draft,
          onChange: (next) => setDraft(next),
          onSubmit: (value) => submit(value),
          onCancel: () => {
            // Esc cancels in-flight work in P1.4. We deliberately do NOT
            // clear the draft here — that matches blessed and avoids losing
            // text the user just typed.
          },
          onArrowDownAtBottom: onArrowDownAtEnd,
          onArrowUpAtTop: onArrowUpAtStart,
          onArrowLeftAtEmpty: () => onArrowSideAtEmpty("left"),
          onArrowRightAtEmpty: () => onArrowSideAtEmpty("right"),
          width: Math.max(20, (size.cols || 80) - 4),
          interactive,
          placeholder: targetAgent
            ? `message @${getAgentLabel(targetAgent)}...`
            : "type a message...",
          promptPrefix: targetAgent ? `›@${getAgentLabel(targetAgent)} ` : "› ",
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
              const reservedForHint = fmt.displayCellWidth(`  │ ${agentsHint}`);
              const budget = Math.max(20, cols - 10 - reservedForHint);
              const plan = fmt.planAgentsFooter(
                labels,
                agentSelectionMode ? selectedAgentIndex : -1,
                budget
              );
              return h(React.Fragment, null,
                ...plan.items.map((item, idx) =>
                  h(React.Fragment, { key: idx },
                    idx > 0 ? h(Text, { color: "gray" }, "  ") : null,
                    h(Text, {
                      wrap: "truncate",
                      color: item.selected ? undefined : "cyan",
                      inverse: item.selected,
                    }, item.label),
                  )
                ),
                plan.overflowed > 0
                  ? h(Text, { color: "gray" }, `  +${plan.overflowed} more`)
                  : null,
              );
            })(),
        h(Text, { wrap: "truncate", color: "gray" }, `  │ ${agentsHint}`),
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
          resolve();
        } catch (err) {
          reject(err);
        }
      })
      .catch(reject);
  });
}

module.exports = { runUcodeInkTui, createUcodeApp, computeStatusText };

/**
 * Pure status-line text builder used by the React component (and unit
 * tests). Returns "UCODE · Ready" while idle and a spinner+message+timer
 * combination while a task is in flight, mirroring updateStatus() in the
 * blessed implementation.
 */
function computeStatusText(status, spinnerTick) {
  const message = String((status && status.message) || "");
  if (!message) return "UCODE · Ready";
  const type = String((status && status.type) || "thinking");
  const indicators = fmt.STATUS_INDICATORS[type] || fmt.STATUS_INDICATORS.thinking;
  const indicator = indicators[Math.max(0, Math.floor(Number(spinnerTick) || 0)) % indicators.length];
  const startedAt = Number.isFinite(status && status.startedAt) ? status.startedAt : 0;
  const timerText = status && status.showTimer && startedAt
    ? ` (${fmt.formatPendingElapsed(Date.now() - startedAt)}, esc cancel)`
    : "";
  return `${indicator} ${message}${timerText}`;
}

function useMemoStatusText(React, status, spinnerTick) {
  // Dependencies intentionally include startedAt so the timer ticks even
  // when the message string is unchanged.
  return React.useMemo(
    () => computeStatusText(status, spinnerTick),
    [status, spinnerTick]
  );
}
