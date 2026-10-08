"use strict";

const fs = require("fs");
const path = require("path");
const MessageManager = require("../bus/message");
const { getUfooPaths } = require("../state/paths");
const { redactSecrets } = require("../../runtime/privacy/redactor");

// Display events are observations, not messages. They never enter an agent's
// inbox and never depend on which peer receives the task's final reply.
function createAgentSurfacePublisher(projectRoot, subscriber) {
  const paths = getUfooPaths(projectRoot);
  const sequence = new MessageManager(paths.busDir, {}, null);
  let pending = Promise.resolve();
  let batch = [];
  let timer = null;
  let lastError = "";
  function reportError(error) {
    const message = redactSecrets(String(error?.message || "unknown display stream error"));
    if (message !== lastError) process.stderr.write(`[internal] display stream unavailable: ${message}\n`);
    lastError = message;
  }
  function drain() {
    if (timer) clearTimeout(timer);
    timer = null;
    const events = batch;
    batch = [];
    for (const safeEvent of events) {
      pending = pending.then(async () => {
        fs.mkdirSync(paths.busEventsDir, { recursive: true });
        const seq = await sequence.getNextSeq();
        const timestamp = new Date().toISOString();
        fs.appendFileSync(path.join(paths.busEventsDir, `${timestamp.slice(0, 10)}.jsonl`), JSON.stringify({
          seq, timestamp, type: "status/agent-surface", event: "agent_surface",
          publisher: subscriber, target: "*", data: { subscriber, surface: safeEvent },
        }) + "\n");
        lastError = "";
      }).catch(reportError);
    }
  }
  function enqueue(event) {
    let safeEvent;
    try { safeEvent = JSON.parse(redactSecrets(JSON.stringify(event))); }
    catch (error) { reportError(error); return; }
    const last = batch.at(-1);
    if (["text_delta", "thinking_delta"].includes(safeEvent.type) && last?.type === safeEvent.type
        && String(last.delta || "").length < 32000) last.delta = String(last.delta || "") + String(safeEvent.delta || "");
    else batch.push(safeEvent);
    if (!timer) { timer = setTimeout(drain, 40); timer.unref?.(); }
  }
  return { enqueue, flush: () => { drain(); return pending; } };
}

function readAgentSurfaceEvents(projectRoot, agentIds, maxBytes = 2 * 1024 * 1024) {
  const accepted = new Set(agentIds);
  const dir = getUfooPaths(projectRoot).busEventsDir;
  let files;
  try { files = fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().slice(-2); }
  catch { return []; }
  const events = [];
  for (const file of files) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, file), "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(Math.min(size, maxBytes));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start) lines.shift();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === "agent_surface" && accepted.has(event.publisher) && event.data?.surface?.type) events.push(event);
        } catch { /* An incomplete tail is picked up by the live bridge. */ }
      }
    } catch { /* History can rotate while a pane attaches. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

module.exports = { createAgentSurfacePublisher, readAgentSurfaceEvents };
