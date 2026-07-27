"use strict";

/**
 * Phase 2 replay harness: apply a transcript event list to a pure reducer
 * shape used by Rust scrollback (JS mirror for fixtures).
 */

const DEFAULT_CAP = 4000;

function createScrollbackState({ cap = DEFAULT_CAP } = {}) {
  return {
    entries: [],
    cap,
    scrollOffset: 0,
    followTail: true,
  };
}

function applyScrollbackEvent(state, event) {
  const next = {
    ...state,
    entries: state.entries.slice(),
  };
  const name = event && event.name;
  const payload = (event && event.payload) || {};
  if (name === "transcript.reset" || name === "app.snapshot") {
    if (name === "app.snapshot" && Array.isArray(payload.entries)) {
      next.entries = payload.entries.map((row, i) => ({
        id: row.id || `e-${i}`,
        kind: row.kind || "system",
        text: String(row.text || ""),
        speaker: String(row.speaker || ""),
      }));
    } else if (name === "transcript.reset") {
      next.entries = [];
    }
    next.scrollOffset = 0;
    next.followTail = true;
  } else if (name === "transcript.append") {
    next.entries.push({
      id: payload.id || `e-${next.entries.length}`,
      kind: payload.kind || "system",
      text: String(payload.text || ""),
      speaker: String(payload.speaker || ""),
    });
  } else if (name === "stream.delta") {
    const id = payload.id || "stream";
    const idx = [...next.entries].reverse().findIndex((e) => e.id === id);
    if (idx >= 0) {
      const real = next.entries.length - 1 - idx;
      next.entries[real] = {
        ...next.entries[real],
        text: `${next.entries[real].text}${payload.text || payload.delta || ""}`,
      };
    } else {
      next.entries.push({
        id,
        kind: "assistant",
        text: String(payload.text || payload.delta || ""),
        speaker: String(payload.speaker || ""),
      });
    }
  }
  while (next.entries.length > next.cap) next.entries.shift();
  if (next.followTail) next.scrollOffset = 0;
  return next;
}

function replayScrollbackEvents(events, options = {}) {
  let state = createScrollbackState(options);
  for (const event of events || []) {
    state = applyScrollbackEvent(state, event);
  }
  return state;
}

module.exports = {
  DEFAULT_CAP,
  createScrollbackState,
  applyScrollbackEvent,
  replayScrollbackEvents,
};
