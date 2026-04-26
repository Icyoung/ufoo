const { normalizeCodexEvent } = require("./codexEventTranslator");
const { redactUfooEvent } = require("../providerapi/redactor");
const { sendUpstreamPrompt } = require("./upstreamTransport");

function resolveCodexSdk() {
  try {
    // Optional dependency during Phase 1a seam work.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require("@openai/codex-sdk");
  } catch (err) {
    const error = new Error("Codex SDK seam enabled but @openai/codex-sdk is not installed");
    error.code = "CODEX_SDK_UNAVAILABLE";
    error.cause = err;
    throw error;
  }
}

function defaultCodexStreamFactory({
  sdk,
  model,
  cwd,
  extraArgs = [],
  threadId = "",
  input,
  opts = {},
}) {
  if (!sdk || typeof sdk.runStreamed !== "function") {
    throw new Error("Codex SDK seam requires runStreamed support");
  }
  const { history, ...sdkOpts } = opts;
  void history;
  return sdk.runStreamed({
    model,
    cwd,
    extraArgs,
    threadId,
    input,
    ...sdkOpts,
  });
}

function createThreadId() {
  return `codex-thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function* defaultCodexTransportStreamFactory({
  model,
  cwd,
  threadId = "",
  input,
  opts = {},
}) {
  const nextThreadId = String(threadId || "").trim() || createThreadId();
  const result = await sendUpstreamPrompt({
    projectRoot: cwd,
    provider: "codex",
    model,
    prompt: String(input || ""),
    messages: Array.isArray(opts.history) ? opts.history : [],
    timeoutMs: Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 120000,
  });
  if (!result.ok) {
    const err = new Error(result.error || "Codex upstream request failed");
    err.code = result.errorCode || "CODEX_UPSTREAM_FAILED";
    throw err;
  }

  yield { type: "thread.started", thread_id: nextThreadId };
  yield {
    type: "item.completed",
    item: { type: "message", text: String(result.output || "") },
  };
  yield {
    type: "turn.completed",
    turn_id: `turn-${Date.now().toString(36)}`,
    usage: result.usage || null,
  };
}

class CodexSdkThread {
  constructor({
    model = "",
    cwd = "",
    extraArgs = [],
    streamFactory = defaultCodexStreamFactory,
    sdk,
    tools = [],
  } = {}) {
    this.id = "";
    this.model = model;
    this.cwd = cwd;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs.slice() : [];
    this.streamFactory = streamFactory;
    this.sdk = sdk;
    this.tools = Array.isArray(tools) ? tools.slice() : [];
    this.messages = [];
  }

  async *runStreamed(input, opts = {}) {
    const mergedOpts = { ...opts };
    if (this.tools.length > 0 && !Array.isArray(mergedOpts.tools)) {
      mergedOpts.tools = this.tools.slice();
    }
    mergedOpts.history = this.messages.slice();
    const stream = this.streamFactory({
      sdk: this.sdk,
      model: this.model,
      cwd: this.cwd,
      extraArgs: this.extraArgs,
      threadId: this.id,
      input,
      opts: mergedOpts,
    });
    let outputText = "";
    for await (const rawEvent of stream) {
      const normalized = normalizeCodexEvent(rawEvent);
      if (!normalized) continue;
      if (normalized.type === "thread_started" && normalized.threadId) {
        this.id = normalized.threadId;
      }
      if (normalized.type === "text_delta" && normalized.delta) {
        outputText += normalized.delta;
      }
      yield redactUfooEvent(normalized);
    }
    this.messages.push({ role: "user", content: String(input || "") });
    this.messages.push({ role: "assistant", content: outputText });
  }

  async close() {
    return undefined;
  }
}

class CodexThreadProvider {
  constructor({
    model = "",
    cwd = "",
    extraArgs = [],
    streamFactory = defaultCodexStreamFactory,
    sdk,
    tools = [],
  } = {}) {
    this.model = model;
    this.cwd = cwd;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs.slice() : [];
    this.streamFactory = streamFactory;
    this.sdk = sdk || (streamFactory === defaultCodexStreamFactory ? resolveCodexSdk() : null);
    this.tools = Array.isArray(tools) ? tools.slice() : [];
  }

  startThread() {
    return new CodexSdkThread({
      model: this.model,
      cwd: this.cwd,
      extraArgs: this.extraArgs,
      streamFactory: this.streamFactory,
      sdk: this.sdk,
      tools: this.tools,
    });
  }

  resumeThread(threadId = "") {
    const thread = this.startThread();
    thread.id = String(threadId || "").trim();
    return thread;
  }
}

function createCodexThreadProvider(options = {}) {
  return new CodexThreadProvider(options);
}

module.exports = {
  CodexSdkThread,
  CodexThreadProvider,
  createCodexThreadProvider,
  defaultCodexStreamFactory,
  defaultCodexTransportStreamFactory,
  resolveCodexSdk,
};
