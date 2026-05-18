"use strict";

/**
 * Minimal Ink smoke-test app for ufoo.
 *
 * Renders a banner, a scrolling log, a status line and a single-line input.
 * Used to verify that ink runs under our Node + CJS environment, that
 * keypress/resize/Ctrl+C all behave, and that we can drive it from a CJS
 * entry point.
 */

function createInkDemo({ React, ink, onExit, interactive = true }) {
  const { useEffect, useState, useCallback } = React;
  const { Box, Text, useInput, useApp, useStdout } = ink;
  const h = React.createElement;

  return function InkDemo(_props) {
    const [logs, setLogs] = useState([
      "ufoo ink demo · type something and press Enter",
      "press q or Ctrl+C to quit",
    ]);
    const [draft, setDraft] = useState("");
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const { exit } = useApp();
    const { stdout } = useStdout();

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () => setSize({ cols: stdout.columns || 0, rows: stdout.rows || 0 });
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    const submit = useCallback(() => {
      const value = draft.trim();
      if (!value) return;
      setLogs((prev) => prev.concat([`> ${value}`]).slice(-200));
      setDraft("");
    }, [draft]);

    useInput((input, key) => {
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
      if (input === "q" && !key.ctrl && !key.meta) {
        if (typeof onExit === "function") onExit();
        exit();
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft((prev) => prev + input);
      }
    }, { isActive: interactive });

    return h(Box, { flexDirection: "column" },
      h(Box, { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
        h(Text, { color: "cyan", bold: true }, "ufoo · ink demo"),
        h(Text, { color: "gray" }, `  ${size.cols}x${size.rows}`),
      ),
      h(Box, { flexDirection: "column", marginTop: 1, height: 12 },
        ...logs.slice(-12).map((line, idx) =>
          h(Text, { key: `${idx}-${line}` }, line)
        ),
      ),
      h(Box, {
        marginTop: 1,
        borderStyle: "single",
        borderTop: true,
        borderBottom: true,
        borderLeft: false,
        borderRight: false,
        borderColor: "gray",
        paddingY: 0,
      },
        h(Text, { color: "magenta" }, "› "),
        h(Text, null, draft),
        h(Text, { color: "gray" }, "▏"),
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: "gray" }, "Enter send · Esc clear · q quit"),
      ),
    );
  };
}

module.exports = { createInkDemo };
