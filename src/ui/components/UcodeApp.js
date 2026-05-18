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
    // statusText becomes dynamic in P1.4 (spinner + phase + bg-task suffix).
    const statusText = "UCODE · Ready";
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const [agents, setAgents] = useState([]);
    const [selectedAgentIndex, setSelectedAgentIndex] = useState(-1);
    const [agentSelectionMode, setAgentSelectionMode] = useState(false);
    const { exit } = useApp();
    const { stdout } = useStdout();
    const lineSeqRef = useRef(banner.length + 1);

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

    const appendLogText = useCallback((text) => {
      // Multi-line text → split into separate log entries so <Static> keys
      // stay stable when streaming arrives line-by-line.
      const raw = String(text == null ? "" : text);
      if (!raw) return;
      const lines = raw.split(/\r?\n/);
      for (const line of lines) appendLogLine(line);
    }, [appendLogLine]);

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
          // P1.4b will render this through the tool-merge state machine.
          // For now just log a one-line summary so users see something.
          const payload = result.result && typeof result.result === "object" ? result.result : {};
          const detail = fmt.normalizeBashToolCommand(result.args, payload);
          const isError = payload.ok === false;
          const marker = isError ? "✗" : "✓";
          appendLogText(`${marker} ${result.tool || "tool"}${detail ? ` · ${detail}` : ""}`);
          return;
        }
        case "nl": {
          let streamBuf = "";
          let nlResult = null;
          try {
            nlResult = await props.runNaturalLanguageTask(result.task, props.state, {
              onPhase: () => {
                // P1.4c: drive the spinner from these events.
              },
              onDelta: (delta) => {
                streamBuf += String(delta || "");
                const parts = streamBuf.split(/\r?\n/);
                while (parts.length > 1) {
                  appendLogLine(parts.shift());
                }
                streamBuf = parts[0];
              },
              onToolLog: (entry) => {
                // P1.4b: merge into ToolGroup state. For now, one line each.
                if (!entry || typeof entry !== "object") return;
                const detail = fmt.normalizeBashToolCommand(entry.args, entry.result);
                const phase = String(entry.phase || "").toLowerCase();
                const marker = phase === "error" || (entry.error && entry.error.length > 0) ? "✗" : "·";
                appendLogText(`${marker} ${entry.tool || "tool"}${detail ? ` · ${detail}` : ""}`);
              },
            });
          } catch (err) {
            appendLogText(`Error: ${err && err.message ? err.message : "agent loop failed"}`);
            return;
          }
          if (streamBuf) appendLogLine(streamBuf);
          const summary = props.formatNlResult(nlResult, false);
          if (summary) appendLogText(summary);
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

    // Top-level only catches Ctrl+C; the editor handles all text editing.
    useInput((input, key) => {
      if (key.ctrl && input === "c") exit();
    }, { isActive: interactive });

    return h(Box, { flexDirection: "column", width: "100%" },
      h(Static, { items: logLines }, (item) =>
        h(Text, { key: item.id }, item.text || " ")
      ),
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
      h(Box, null,
        h(Text, { color: "gray" }, "Agents: "),
        agents.length === 0
          ? h(Text, { color: "cyan" }, "none")
          : h(Box, null, ...agents.map((agent, idx) => {
              const label = getAgentLabel(agent);
              const isSelected = agentSelectionMode && idx === selectedAgentIndex;
              return h(React.Fragment, { key: agent.fullId || `${agent.type}:${idx}` },
                idx > 0 ? h(Text, { color: "gray" }, "  ") : null,
                h(Text, {
                  color: isSelected ? undefined : "cyan",
                  inverse: isSelected,
                }, `@${label}`),
              );
            })),
        h(Text, { color: "gray" }, `  │ ${agentsHint}`),
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

module.exports = { runUcodeInkTui, createUcodeApp };
