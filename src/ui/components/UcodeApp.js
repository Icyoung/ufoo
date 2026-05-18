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

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () =>
        setSize({ cols: stdout.columns || 0, rows: stdout.rows || 0 });
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    const submit = useCallback((submitted) => {
      const value = String(submitted == null ? draft : submitted).trim();
      if (!value) return;
      setDraft("");
      appendLogLine(`› ${value}`);
      appendLogLine("(runner not wired yet — P1.4)");
    }, [draft, appendLogLine]);

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
