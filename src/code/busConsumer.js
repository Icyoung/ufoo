const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { createBusProgressReporter } = require("./taskDecomposer");
const { DeliveryQueue } = require("../coordination/bus/deliveryQueue");

function shellQuote(value = "") {
  const text = String(value == null ? "" : value);
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function toText(value = "") {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value == null ? "" : value);
}

function stripAnsi(text = "") {
  const raw = String(text || "");
  if (!raw) return "";
  // CSI + OSC sequences (best-effort).
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)/g, "");
}

// Bound every shell capture so a hung `ufoo bus` CLI cannot freeze the
// agent loop (autoBus re-invokes this every 800ms).
const SHELL_CAPTURE_TIMEOUT_MS = 15000;

function runShellCapture(command = "", workspaceRoot = process.cwd()) {
  try {
    const output = execSync(String(command || ""), {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: SHELL_CAPTURE_TIMEOUT_MS,
    });
    return {
      ok: true,
      output: toText(output),
      error: "",
    };
  } catch (err) {
    const stdout = toText(err && err.stdout);
    const stderr = toText(err && err.stderr);
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      ok: false,
      output: detail,
      error: detail || (err && err.message ? err.message : "shell command failed"),
    };
  }
}

function safeSubscriberName(subscriberId = "") {
  return String(subscriberId || "").replace(/:/g, "_");
}

function resolvePendingQueueFile(workspaceRoot = process.cwd(), subscriberId = "") {
  const root = String(workspaceRoot || process.cwd()).trim() || process.cwd();
  const sub = String(subscriberId || "").trim();
  if (!sub) return "";
  return path.join(root, ".ufoo", "bus", "queues", safeSubscriberName(sub), "pending.jsonl");
}

function resolveUfooProjectRoot(preferredRoot = "", env = process.env) {
  const candidates = [
    String(preferredRoot || "").trim(),
    String((env && env.UFOO_UCODE_PROJECT_ROOT) || "").trim(),
    String((env && env.UFOO_PROJECT_ROOT) || "").trim(),
    process.cwd(),
  ].filter(Boolean);

  for (const root of candidates) {
    try {
      const busDir = path.join(root, ".ufoo", "bus");
      if (fs.existsSync(busDir)) return root;
    } catch {
      // ignore
    }
  }

  return candidates[0] || process.cwd();
}

function countPendingQueueLines(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return 0;
  try {
    if (!fs.existsSync(target)) return 0;
    const content = String(fs.readFileSync(target, "utf8") || "");
    if (!content.trim()) return 0;
    return content.split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function isPidAlive(pid) {
  const p = parseInt(String(pid || "").trim(), 10);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

function listProcessingFiles(pendingFilePath = "") {
  const pendingFile = String(pendingFilePath || "").trim();
  if (!pendingFile) return [];
  const dir = path.dirname(pendingFile);
  const base = path.basename(pendingFile);
  const prefix = `${base}.processing.`;
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name && name.startsWith(prefix))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function countRecoverableProcessingFiles(pendingFilePath = "", options = {}) {
  const pendingFile = String(pendingFilePath || "").trim();
  if (!pendingFile) return 0;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 60000;
  const now = Date.now();
  const files = listProcessingFiles(pendingFile);
  let count = 0;

  for (const file of files) {
    const name = path.basename(file);
    const m = name.match(/\.processing\.(\d+)\./);
    const pid = m ? parseInt(m[1], 10) : NaN;

    if (Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) {
      count += 1;
      continue;
    }

    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) continue;
    try {
      const stat = fs.statSync(file);
      if (stat && stat.isFile() && (now - stat.mtimeMs > maxAgeMs)) {
        count += 1;
      }
    } catch {
      // ignore
    }
  }

  return count;
}

function getPendingBusCount(workspaceRoot = process.cwd(), subscriberId = "") {
  const pendingFile = resolvePendingQueueFile(workspaceRoot, subscriberId);
  const pendingLines = countPendingQueueLines(pendingFile);
  if (!pendingFile) return pendingLines;
  // If a prior crash left `.processing.*` behind, count it so autoBus can self-heal.
  const recoverable = countRecoverableProcessingFiles(pendingFile, { maxAgeMs: 60000 });
  return pendingLines + recoverable;
}

function drainJsonlFile(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return { drained: [], rawLines: [], error: "" };
  const queue = new DeliveryQueue(target);
  const drained = [];
  const rawLines = [];
  const claims = [];
  try {
    queue.recover();
    while (true) {
      const claim = queue.claimNext();
      if (!claim) break;
      claims.push(claim);
      drained.push(claim.event);
      rawLines.push(JSON.stringify(claim.event));
      queue.completeClaim(claim);
    }
  } catch (err) {
    for (const claim of claims) queue.restoreClaim(claim);
    return { drained: [], rawLines: [], error: err && err.message ? err.message : "drain failed" };
  }
  return {
    drained,
    rawLines,
    error: "",
    claims,
    processingFile: claims[0] ? claims[0].processingFile : "",
  };
}

function extractTaskFromBusEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (String(evt.event || "").trim().toLowerCase() !== "message") return null;
  let publisher = "";
  if (typeof evt.publisher === "string") {
    publisher = String(evt.publisher || "").trim();
  } else if (evt.publisher && typeof evt.publisher === "object") {
    publisher = String(evt.publisher.subscriber || evt.publisher.nickname || "").trim();
  } else {
    publisher = String(evt.publisher || "").trim();
  }
  if (publisher === "[object Object]") publisher = "";
  if (!publisher) return null;
  const data = evt.data && typeof evt.data === "object" ? evt.data : {};
  const message = typeof data.message === "string"
    ? data.message
    : (typeof data.text === "string" ? data.text : "");
  const task = String(message || "").trim();
  if (!task) return null;
  return { publisher, task };
}

function shouldAutoConsumeBus(subscriberId = "") {
  const id = String(subscriberId || "").trim().toLowerCase();
  if (!id) return false;
  return id.startsWith("ufoo-code:")
    || id.startsWith("ucode:")
    || id.startsWith("ufoo:");
}

function extractBusMessageTask(contentRaw = "") {
  const raw = String(contentRaw || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
      if (typeof parsed.prompt === "string" && parsed.prompt.trim()) return parsed.prompt.trim();
    }
  } catch {
    // treat as plain text below
  }
  return raw;
}

function busCheckOutputIndicatesPending(raw = "") {
  const text = stripAnsi(String(raw || ""));
  if (!text.trim()) return false;
  if (/no pending messages/i.test(text)) return false;
  if (/you have\s+\d+\s+pending/i.test(text)) return true;
  if (/after handling,\s*run:\s*ufoo bus ack/i.test(text)) return true;
  if (/pending event/i.test(text)) return true;
  return false;
}

function parseBusCheckOutput(raw = "") {
  const text = stripAnsi(String(raw || ""));
  if (!text.trim()) return [];
  if (/no pending messages/i.test(text)) return [];

  const lines = text.split(/\r?\n/);
  const rows = [];
  let current = null;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    const header = trimmed.match(/^@.+\s+from\s+([^\s]+)\s*$/i);
    if (header) {
      if (current && current.publisher) rows.push(current);
      current = {
        publisher: String(header[1] || "").trim(),
        content: "",
      };
      continue;
    }

    if (!current) continue;

    const contentMatch = trimmed.match(/^content:\s*(.*)$/i);
    if (contentMatch) {
      current.content = String(contentMatch[1] || "").trim();
      continue;
    }

    if (
      current.content
      && !/^(type|event|seq|target|timestamp):\s*/i.test(trimmed)
      && !trimmed.startsWith("@")
    ) {
      current.content = `${current.content}\n${trimmed}`;
    }
  }

  if (current && current.publisher) rows.push(current);

  return rows
    .map((entry) => {
      const publisher = String(entry.publisher || "").trim();
      const content = String(entry.content || "").trim();
      const task = extractBusMessageTask(content);
      if (!publisher || !task) return null;
      return {
        publisher,
        content,
        task,
      };
    })
    .filter(Boolean);
}

async function runUbusCommand(state = {}, options = {}) {
  const runtimeWorkspace = resolveUfooProjectRoot(String(
    options.workspaceRoot
      || (state && state.workspaceRoot)
      || ""
  ));
  const shell = typeof options.execShell === "function"
    ? options.execShell
    : (command) => runShellCapture(command, runtimeWorkspace);
  const runNl = typeof options.runNaturalLanguageTaskImpl === "function"
    ? options.runNaturalLanguageTaskImpl
    : require("./agent").runNaturalLanguageTask;
  const formatNl = typeof options.formatNlResultImpl === "function"
    ? options.formatNlResultImpl
    : require("./agent").formatNlResult;
  const onMessageReceived = typeof options.onMessageReceived === "function"
    ? options.onMessageReceived
    : null;

  const explicitSubscriber = String(options.subscriberId || "").trim();
  const envSubscriber = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
  let subscriberId = explicitSubscriber || envSubscriber;
  if (!subscriberId) {
    const whoami = shell("ufoo bus whoami 2>/dev/null || true");
    subscriberId = String((whoami && whoami.output) || "").trim();
  }
  if (!subscriberId) {
    const joined = shell("ufoo bus join | tail -1");
    subscriberId = String((joined && joined.output) || "").trim();
  }
  if (!subscriberId) {
    return {
      ok: false,
      summary: "",
      error: "failed to resolve bus subscriber id",
      handled: 0,
      subscriberId: "",
    };
  }

  // Prefer consuming pending.jsonl directly (stable, ANSI/wrapping-proof).
  const pendingFile = resolvePendingQueueFile(runtimeWorkspace, subscriberId);
  const queue = pendingFile ? new DeliveryQueue(pendingFile) : null;
  if (queue) queue.recover();
  const hasPendingFile = Boolean(pendingFile && fs.existsSync(pendingFile));
  let handled = 0;
  const sendErrors = [];
  const messageExchanges = [];

  if (queue && hasPendingFile) {
    while (fs.existsSync(pendingFile)) {
      const claim = queue.claimNext();
      if (!claim) break;
      const message = extractTaskFromBusEvent(claim.event);
      if (!message) {
        queue.completeClaim(claim);
        continue;
      }
      let nlResult;

      // Notify that we received the message (for immediate display)
      if (onMessageReceived) {
        onMessageReceived({
          from: message.publisher,
          task: message.task,
        });
      }

      // Create progress reporter for this message
      const progressReporter = createBusProgressReporter(shell, message.publisher);

      try {
        // Send initial acknowledgment
        shell(`ufoo bus send ${shellQuote(message.publisher)} ${shellQuote("🚀 Starting task...")}`);

        // eslint-disable-next-line no-await-in-loop
        nlResult = await runNl(message.task, state, {
          onProgress: progressReporter,
          signal: options.signal,
        });
      } catch (err) {
        const errorMessage = err && err.message ? err.message : "task failed";
        sendErrors.push(`task from ${message.publisher} failed: ${errorMessage}`);
        queue.restoreClaim(claim);
        // Send error notification
        shell(`ufoo bus send ${shellQuote(message.publisher)} ${shellQuote(`❌ Error: ${errorMessage}`)}`);
        break;
      }
      const reply = String(formatNl(nlResult, false) || "").replace(/\s+/g, " ").trim() || "Done.";
      const sendRes = shell(`ufoo bus send ${shellQuote(message.publisher)} ${shellQuote(reply.slice(0, 2000))}`);
      if (!sendRes.ok) {
        sendErrors.push(`reply to ${message.publisher} failed: ${sendRes.error || "send failed"}`);
        queue.restoreClaim(claim);
        break;
      }
      handled += 1;
      queue.completeClaim(claim);
      messageExchanges.push({
        from: message.publisher,
        task: message.task,
        reply,
      });
    }
  }

  // Fallback: if there is no pending file, fall back to CLI `bus check` parsing.
  if (!hasPendingFile) {
    const checked = shell(`ufoo bus check ${shellQuote(subscriberId)}`);
    if (!checked.ok) {
      return {
        ok: false,
        summary: "",
        error: checked.error || "ufoo bus check failed",
        handled: 0,
        subscriberId,
      };
    }
    const parsed = parseBusCheckOutput(checked.output);
    if (parsed.length === 0 && busCheckOutputIndicatesPending(checked.output)) {
      return {
        ok: false,
        summary: "",
        error: "failed to parse ufoo bus check output (pending events detected).",
        handled: 0,
        subscriberId,
      };
    }
    for (const item of parsed) {
      // Notify that we received the message (for immediate display)
      if (onMessageReceived) {
        onMessageReceived({
          from: item.publisher,
          task: item.task,
        });
      }

      const nlResult = await runNl(item.task, state, {
        signal: options.signal,
      });
      const reply = String(formatNl(nlResult, false) || "").replace(/\s+/g, " ").trim() || "Done.";
      const sendRes = shell(`ufoo bus send ${shellQuote(item.publisher)} ${shellQuote(reply.slice(0, 2000))}`);
      if (!sendRes.ok) {
        sendErrors.push(`reply to ${item.publisher} failed: ${sendRes.error || "send failed"}`);
        continue;
      }
      handled += 1;
      messageExchanges.push({
        from: item.publisher,
        task: item.task,
        reply,
      });
    }
  }

  if (sendErrors.length > 0) {
    return {
      ok: false,
      summary: "",
      error: sendErrors.join("; "),
      handled,
      subscriberId,
      messageExchanges,
    };
  }

  const summary = handled > 0
    ? `ubus: handled ${handled} message${handled === 1 ? "" : "s"} for ${subscriberId}.`
    : `ubus: no pending messages for ${subscriberId}.`;
  return {
    ok: true,
    summary,
    error: "",
    handled,
    subscriberId,
    messageExchanges,
  };
}

module.exports = {
  runUbusCommand,
  parseBusCheckOutput,
  extractBusMessageTask,
  runShellCapture,
  stripAnsi,
  busCheckOutputIndicatesPending,
  resolvePendingQueueFile,
  resolveUfooProjectRoot,
  countPendingQueueLines,
  getPendingBusCount,
  drainJsonlFile,
  extractTaskFromBusEvent,
  shouldAutoConsumeBus,
};
