const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { DEFAULT_ASSISTANT_TIMEOUT_MS } = require("../assistant/constants");

const ROUTER_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    reply: { type: "string" },
    assistant_call: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["explore", "bash", "mixed"] },
        task: { type: "string" },
        context: { type: "string" },
        expect: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      required: ["task"],
    },
    dispatch: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        required: ["target", "message"],
      },
    },
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["launch", "close", "rename", "cron"] },
          agent: { type: "string" },
          count: { type: "integer" },
          agent_id: { type: "string" },
          nickname: { type: "string" },
          operation: { type: "string", enum: ["start", "list", "stop", "add", "create", "ls", "rm", "remove"] },
          every: { type: "string" },
          interval_ms: { type: "integer" },
          target: { type: "string" },
          targets: {
            type: "array",
            items: { type: "string" },
          },
          prompt: { type: "string" },
          id: { type: "string" },
        },
        required: ["action"],
      },
    },
    disambiguate: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              reason: { type: "string" },
            },
            required: ["agent_id"],
          },
        },
      },
    },
  },
  required: ["reply", "dispatch", "ops"],
});

function collectJsonl(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines
    }
  }
  return items;
}

function collectJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeInvoke(callback, ...args) {
  if (typeof callback !== "function") return;
  try {
    callback(...args);
  } catch {
    // Swallow stream callback errors to avoid breaking CLI execution.
  }
}

function normalizeDelta(value) {
  if (typeof value === "string") return value;
  return "";
}

const CORE_TOOL_NAMES = new Set(["read", "write", "edit", "bash"]);

function normalizeCoreToolName(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  return CORE_TOOL_NAMES.has(text) ? text : "";
}

function parseMaybeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore invalid json
  }
  return {};
}

function collectNestedObjects(root, maxDepth = 4) {
  const out = [];
  const seen = new Set();

  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > maxDepth) return;
    if (seen.has(node)) return;
    seen.add(node);
    out.push(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  }

  walk(root, 0);
  return out;
}

function inferToolPhase(event = {}, candidate = {}) {
  const source = [
    event.type,
    event.event,
    event.status,
    candidate.type,
    candidate.status,
  ]
    .map((part) => String(part || "").toLowerCase())
    .join(" ");

  if (!source) return "update";
  if (/error|failed|failure|cancelled|canceled|abort/.test(source)) return "error";
  if (/done|completed|finished|result|end|succeeded/.test(source)) return "end";
  if (/start|started|begin|call|invoke|created|added|delta|progress/.test(source)) return "start";
  return "update";
}

function buildToolArgs(tool = "", candidate = {}) {
  const rawArgs = candidate.args
    || candidate.arguments
    || candidate.input
    || candidate.params
    || candidate.payload
    || {};
  const parsed = parseMaybeJsonObject(rawArgs);
  if (Object.keys(parsed).length > 0) return parsed;

  // Common direct fields seen in tool events.
  if (tool === "bash") {
    const command = String(candidate.command || candidate.cmd || "").trim();
    return command ? { command } : {};
  }
  if (tool === "read" || tool === "write" || tool === "edit") {
    const filePath = String(candidate.path || candidate.file || "").trim();
    if (filePath) return { path: filePath };
  }
  return {};
}

function buildToolEventKey(event = {}, candidate = {}, tool = "", phase = "", args = {}) {
  const id = String(
    event.id
    || event.item_id
    || candidate.id
    || candidate.call_id
    || candidate.tool_call_id
    || ""
  ).trim();
  if (id) return `${tool}|${phase}|${id}`;

  const details = JSON.stringify({
    path: args.path || args.file || "",
    command: args.command || args.cmd || "",
  });
  return `${tool}|${phase}|${details}`;
}

function extractCodexToolEvent(event = {}, state = null) {
  const objects = collectNestedObjects(event, 4);
  for (const candidate of objects) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const tool = normalizeCoreToolName(
      candidate.tool
      || candidate.tool_name
      || candidate.name
      || candidate.function_name
      || candidate.action
      || candidate.type
    );
    if (!tool) continue;

    const args = buildToolArgs(tool, candidate);
    const phase = inferToolPhase(event, candidate);
    const error = String(candidate.error || candidate.message || "").trim();
    const key = buildToolEventKey(event, candidate, tool, phase, args);
    if (state && state.seenToolEventKeys instanceof Set) {
      if (state.seenToolEventKeys.has(key)) continue;
      state.seenToolEventKeys.add(key);
    }

    return {
      tool,
      phase,
      args,
      error,
      rawType: String(event.type || ""),
    };
  }
  return null;
}

function extractTextFromContentBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (typeof block.output_text === "string") return block.output_text;
  if (typeof block.delta === "string") return block.delta;
  return "";
}

function extractTextFromCodexItem(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.delta === "string") return item.delta;
  if (typeof item.output_text === "string") return item.output_text;
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) => extractTextFromContentBlock(part))
      .filter(Boolean)
      .join("");
    if (text) return text;
  }
  if (item.item && typeof item.item === "object") {
    return extractTextFromCodexItem(item.item);
  }
  return "";
}

function extractCodexStreamDelta(event) {
  if (!event || typeof event !== "object") return "";

  if (
    event.assistantMessageEvent
    && typeof event.assistantMessageEvent === "object"
    && typeof event.assistantMessageEvent.delta === "string"
  ) {
    return event.assistantMessageEvent.delta;
  }

  if (typeof event.delta === "string") return event.delta;
  if (typeof event.output_text === "string") return event.output_text;
  if (event.item && typeof event.item === "object") {
    return extractTextFromCodexItem(event.item);
  }
  if (event.message && typeof event.message === "object") {
    return extractTextFromCodexItem(event.message);
  }
  return "";
}

function createCodexJsonlStreamParser(onDeltaOrOptions, maybeOnToolEvent) {
  let onDelta = null;
  let onToolEvent = null;
  if (typeof onDeltaOrOptions === "function") {
    onDelta = onDeltaOrOptions;
    onToolEvent = typeof maybeOnToolEvent === "function" ? maybeOnToolEvent : null;
  } else if (onDeltaOrOptions && typeof onDeltaOrOptions === "object") {
    onDelta = typeof onDeltaOrOptions.onDelta === "function" ? onDeltaOrOptions.onDelta : null;
    onToolEvent = typeof onDeltaOrOptions.onToolEvent === "function"
      ? onDeltaOrOptions.onToolEvent
      : null;
  }

  let buffer = "";
  const toolState = { seenToolEventKeys: new Set() };

  function parseLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const delta = normalizeDelta(extractCodexStreamDelta(parsed));
    if (delta) {
      safeInvoke(onDelta, delta, parsed);
    }
    const toolEvent = extractCodexToolEvent(parsed, toolState);
    if (toolEvent) {
      safeInvoke(onToolEvent, toolEvent, parsed);
    }
  }

  return {
    onChunk(chunk) {
      const text = String(chunk || "");
      if (!text) return;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        parseLine(line);
      }
    },
    flush() {
      if (!buffer) return;
      parseLine(buffer);
      buffer = "";
    },
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let settled = false;

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (typeof options.onSpawn === "function") {
      try {
        options.onSpawn(child);
      } catch {
        // ignore callback failures
      }
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString("utf8");
      stdout += chunk;
      if (options.onStdout) {
        options.onStdout(chunk);
      }
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString("utf8");
      stderr += chunk;
      if (options.onStderr) {
        options.onStderr(chunk);
      }
    });
    let timeout = null;
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        settleReject(new Error(`CLI timeout (${options.timeoutMs}ms)`));
      }, options.timeoutMs);
    }

    let abortHandler = null;
    if (options.signal && typeof options.signal.addEventListener === "function") {
      abortHandler = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        settleReject(new Error("CLI cancelled"));
      };
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (abortHandler && options.signal && typeof options.signal.removeEventListener === "function") {
        options.signal.removeEventListener("abort", abortHandler);
      }
      settleReject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (abortHandler && options.signal && typeof options.signal.removeEventListener === "function") {
        options.signal.removeEventListener("abort", abortHandler);
      }
      settleResolve({ code, stdout, stderr });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

const DEFAULT_CLAUDE = {
  command: "claude",
  args: [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--json-schema",
    ROUTER_JSON_SCHEMA,
  ],
  fallbackArgs: [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--json-schema",
    ROUTER_JSON_SCHEMA,
  ],
  output: "json",
  input: "arg",
  modelArg: "--model",
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
};

const DEFAULT_CODEX = {
  command: "codex",
  args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
  output: "jsonl",
  input: "arg",
  modelArg: "--model",
  sessionArg: null,
  fallbackArgs: ["exec", "--json", "--color", "never", "--sandbox", "read-only"],
};

function buildArgs(backend, prompt, opts) {
  const args = [...(backend.args || [])];
  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs.filter(Boolean) : [];
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }
  if (opts.model && backend.modelArg) {
    args.push(backend.modelArg, opts.model);
  }
  if (opts.sessionId && backend.sessionArg && !opts.disableSession) {
    args.push(backend.sessionArg, opts.sessionId);
  }
  if (opts.systemPrompt && backend.systemPromptArg) {
    args.push(backend.systemPromptArg, opts.systemPrompt);
  }
  if (backend.input === "arg") {
    args.push(prompt);
    return { args, stdin: "" };
  }
  return { args, stdin: prompt };
}

function applySandboxOverride(args, sandbox) {
  if (!sandbox) return;
  const idx = args.indexOf("--sandbox");
  if (idx >= 0) {
    if (idx + 1 < args.length) {
      args[idx + 1] = sandbox;
    } else {
      args.push(sandbox);
    }
  } else {
    args.push("--sandbox", sandbox);
  }
}

function applyClaudeJsonSchema(args, jsonSchema) {
  if (!jsonSchema) return;
  const schema = typeof jsonSchema === "string" ? jsonSchema : JSON.stringify(jsonSchema);
  const idx = args.indexOf("--json-schema");
  if (idx >= 0) {
    if (idx + 1 < args.length) {
      args[idx + 1] = schema;
    } else {
      args.push(schema);
    }
    return;
  }
  args.push("--json-schema", schema);
}

function isUnsupportedArgError(errText) {
  const text = (errText || "").toLowerCase();
  return text.includes("unknown option")
    || text.includes("unknown argument")
    || text.includes("unexpected argument")
    || text.includes("unrecognized option");
}

function extractUnsupportedOption(errText) {
  const text = String(errText || "");
  const quoted = text.match(/['"`](--[a-z0-9-]+)['"`]/i);
  if (quoted && quoted[1]) return quoted[1];
  const plain = text.match(/(--[a-z0-9-]+)/i);
  return plain && plain[1] ? plain[1] : "";
}

function removeUnsupportedOption(args, option) {
  const out = Array.isArray(args) ? args.slice() : [];
  const target = String(option || "").trim();
  if (!target) return { changed: false, args: out };
  const idx = out.indexOf(target);
  if (idx < 0) return { changed: false, args: out };

  const optionsWithValue = new Set([
    "--json-schema",
    "--model",
    "--session-id",
    "--append-system-prompt",
    "--output-format",
    "--sandbox",
  ]);
  const takesValue = optionsWithValue.has(target);
  out.splice(idx, takesValue ? 2 : 1);
  return { changed: true, args: out };
}

async function runCliAgent(params) {
  const backend = params.provider === "codex-cli" ? DEFAULT_CODEX : DEFAULT_CLAUDE;
  const sessionId = params.sessionId || randomUUID();
  const streamState = { emitted: false };
  const emitStreamDelta = (delta, meta = null) => {
    const text = normalizeDelta(delta);
    if (!text) return;
    streamState.emitted = true;
    safeInvoke(params.onStreamDelta, text, meta);
  };
  const emitToolEvent = (event, meta = null) => {
    if (!event || typeof event !== "object") return;
    safeInvoke(params.onToolEvent, event, meta);
  };
  const prompt =
    params.systemPrompt && !backend.systemPromptArg
      ? `${params.systemPrompt}\n\n${params.prompt}`
      : params.prompt;
  const { args, stdin } = buildArgs(backend, prompt, {
    model: params.model,
    sessionId,
    systemPrompt: params.systemPrompt,
    disableSession: params.disableSession,
    extraArgs: params.extraArgs,
  });
  if (backend === DEFAULT_CODEX && params.sandbox) {
    applySandboxOverride(args, params.sandbox);
  }
  if (backend === DEFAULT_CLAUDE && params.jsonSchema) {
    applyClaudeJsonSchema(args, params.jsonSchema);
  }

  let res;
  const env = { ...process.env, ...(params.env || {}) };
  // Clean up ufoo-specific env vars to avoid interference with CLI agents
  delete env.UFOO_SUBSCRIBER_ID;
  let codexParser = null;
  if (
    backend === DEFAULT_CODEX
    && (typeof params.onStreamDelta === "function" || typeof params.onToolEvent === "function")
  ) {
    codexParser = createCodexJsonlStreamParser({
      onDelta: (delta, event) =>
        emitStreamDelta(delta, { backend: "codex", event }),
      onToolEvent: (event, rawEvent) =>
        emitToolEvent(event, { backend: "codex", event: rawEvent }),
    });
  }
  try {
    res = await runCommand(backend.command, args, {
      cwd: params.cwd,
      env,
      input: stdin,
      timeoutMs: params.timeoutMs || DEFAULT_ASSISTANT_TIMEOUT_MS,
      onStdout: codexParser ? (chunk) => codexParser.onChunk(chunk) : null,
      signal: params.signal,
    });
    if (codexParser) codexParser.flush();
  } catch (err) {
    return { ok: false, error: err.message || String(err), sessionId, streamed: streamState.emitted };
  }

  if (res.code !== 0) {
    let lastErr = res.stderr || res.stdout || "CLI failed";
    let retryArgs = args.slice();
    let retryStdin = stdin;
    let usedFallbackPreset = false;

    for (let attempt = 0; attempt < 3 && isUnsupportedArgError(lastErr); attempt += 1) {
      if (!usedFallbackPreset && backend.fallbackArgs) {
        const retry = buildArgs(
          { ...backend, args: backend.fallbackArgs },
          prompt,
          {
            model: params.model,
            sessionId,
            systemPrompt: params.systemPrompt,
            disableSession: params.disableSession,
            extraArgs: params.extraArgs,
          },
        );
        retryArgs = retry.args;
        retryStdin = retry.stdin;
        if (params.sandbox) {
          applySandboxOverride(retryArgs, params.sandbox);
        }
        if (backend === DEFAULT_CLAUDE && params.jsonSchema) {
          applyClaudeJsonSchema(retryArgs, params.jsonSchema);
        }
        usedFallbackPreset = true;
      } else {
        const unsupportedOption = extractUnsupportedOption(lastErr);
        const dropped = removeUnsupportedOption(retryArgs, unsupportedOption);
        if (!dropped.changed) {
          break;
        }
        retryArgs = dropped.args;
      }

      let retryParser = null;
      if (
        backend === DEFAULT_CODEX
        && (typeof params.onStreamDelta === "function" || typeof params.onToolEvent === "function")
      ) {
        retryParser = createCodexJsonlStreamParser({
          onDelta: (delta, event) =>
            emitStreamDelta(delta, { backend: "codex", event }),
          onToolEvent: (event, rawEvent) =>
            emitToolEvent(event, { backend: "codex", event: rawEvent }),
        });
      }
      try {
        res = await runCommand(backend.command, retryArgs, {
          cwd: params.cwd,
          env,
          input: retryStdin,
          timeoutMs: params.timeoutMs || DEFAULT_ASSISTANT_TIMEOUT_MS,
          onStdout: retryParser ? (chunk) => retryParser.onChunk(chunk) : null,
          signal: params.signal,
        });
        if (retryParser) retryParser.flush();
      } catch (err2) {
        return { ok: false, error: err2.message || String(err2), sessionId, streamed: streamState.emitted };
      }

      if (res.code === 0) break;
      lastErr = res.stderr || res.stdout || "CLI failed";
    }

    if (res.code !== 0) {
      return { ok: false, error: lastErr, sessionId, streamed: streamState.emitted };
    }
  }

  if (backend.output === "jsonl") {
    return { ok: true, sessionId, output: collectJsonl(res.stdout), streamed: streamState.emitted };
  }

  return { ok: true, sessionId, output: collectJson(res.stdout), streamed: streamState.emitted };
}

module.exports = {
  runCliAgent,
  extractCodexStreamDelta,
  extractCodexToolEvent,
  createCodexJsonlStreamParser,
};
