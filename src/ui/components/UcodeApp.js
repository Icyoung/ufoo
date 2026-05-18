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

function createUcodeApp({ React, ink, props, interactive = true }) {
  const { useEffect, useState, useCallback, useRef } = React;
  const { Box, Text, Static, useInput, useApp, useStdout } = ink;
  const h = React.createElement;

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
    const statusText = "UCODE · Ready · Enter send · Esc cancel · Ctrl+C quit";
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const { exit } = useApp();
    const { stdout } = useStdout();
    const lineSeqRef = useRef(banner.length + 1);

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

    const submit = useCallback(() => {
      const value = draft.trim();
      if (!value) return;
      setDraft("");
      appendLogLine(`› ${value}`);
      appendLogLine("(runner not wired yet — P1.4)");
    }, [draft, appendLogLine]);

    useInput((input, key) => {
      // Ctrl+C is also caught by ink's exitOnCtrlC, but handle it explicitly
      // here so the "Ctrl+C quit" hint in the status line stays truthful.
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      if (key.return) {
        submit();
        return;
      }
      if (key.escape) {
        setDraft("");
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft((prev) => prev + input);
      }
    }, { isActive: interactive });

    return h(Box, { flexDirection: "column" },
      h(Static, { items: logLines }, (item) =>
        h(Text, { key: item.id }, item.text || " ")
      ),
      h(Box, {
        marginTop: 1,
        borderStyle: "single",
        borderTop: true,
        borderBottom: true,
        borderLeft: false,
        borderRight: false,
        borderColor: "gray",
      },
        h(Text, { color: "magenta" }, "› "),
        h(Text, null, draft),
        h(Text, { color: "gray" }, "▏"),
      ),
      h(Box, { marginTop: 0 },
        h(Text, { color: "gray" }, statusText),
        size.cols > 0 ? h(Text, { color: "gray" }, ` · ${size.cols}x${size.rows}`) : null,
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
