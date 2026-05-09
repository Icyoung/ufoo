"use strict";

const {
  createClaudeEventState,
  normalizeClaudeEvent,
  normalizeClaudeMessage,
  normalizeClaudeUsage,
} = require("./claudeEventTranslator");
const { redactUfooEvent } = require("../providerapi/redactor");

const CACHE_CONTROL = Object.freeze({ type: "ephemeral" });

function createThreadId() {
  return `claude-thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveAnthropicSdk() {
  try {
    // Optional dependency during Phase 1b seam work.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require("@anthropic-ai/sdk");
  } catch (err) {
    const error = new Error("Claude API seam enabled but @anthropic-ai/sdk is not installed");
    error.code = "ANTHROPIC_SDK_UNAVAILABLE";
    error.cause = err;
    throw error;
  }
}

async function resolveClaudeAgentSdk() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch (err) {
    const error = new Error("Claude Agent SDK mode requires @anthropic-ai/claude-agent-sdk");
    error.code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
    error.cause = err;
    throw error;
  }
}

function resolveClaudeAgentQuery(sdk) {
  const query = sdk && (sdk.query || (sdk.default && sdk.default.query));
  if (typeof query !== "function") {
    throw new Error("Claude Agent SDK module does not export query");
  }
  return query;
}

async function defaultClaudeAuthProvider() {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("Claude API seam requires an authProvider or ANTHROPIC_API_KEY");
    error.code = "CLAUDE_AUTH_UNAVAILABLE";
    throw error;
  }
  return { apiKey };
}

function defaultClaudeClientFactory({ sdk, auth = {} }) {
  if (auth.client) return auth.client;
  const Anthropic = sdk && (sdk.Anthropic || sdk.default || sdk);
  if (!Anthropic) {
    throw new Error("Anthropic SDK seam missing Anthropic client constructor");
  }
  const options = {};
  if (auth.apiKey) options.apiKey = auth.apiKey;
  if (auth.baseUrl) options.baseURL = auth.baseUrl;
  if (auth.headers && typeof auth.headers === "object") {
    options.defaultHeaders = { ...auth.headers };
  }
  return new Anthropic(options);
}

function defaultClaudeStreamFactory({ client, request }) {
  if (!client || !client.messages || typeof client.messages.create !== "function") {
    throw new Error("Claude API seam requires client.messages.create");
  }
  return client.messages.create({
    ...request,
    stream: true,
  });
}

function defaultClaudeAgentStreamFactory({ sdk, input, options }) {
  const query = resolveClaudeAgentQuery(sdk);
  return query({
    prompt: String(input || ""),
    options,
  });
}

function normalizeToolDefinition(tool = {}) {
  const item = tool && typeof tool === "object" ? tool : {};
  return {
    name: String(item.name || "").trim(),
    description: String(item.description || "").trim(),
    input_schema: item.input_schema || item.inputSchema || { type: "object", properties: {} },
  };
}

function normalizeMessageInput(input) {
  if (typeof input === "string") {
    return {
      role: "user",
      content: [{ type: "text", text: input }],
    };
  }
  if (Array.isArray(input)) {
    return {
      role: "user",
      content: input,
    };
  }
  if (input && typeof input === "object" && input.role && input.content) {
    return {
      role: String(input.role),
      content: Array.isArray(input.content) ? input.content : [input.content],
    };
  }
  return {
    role: "user",
    content: [{ type: "text", text: String(input || "") }],
  };
}

function normalizeContentBlocks(content) {
  if (Array.isArray(content)) return content.filter((item) => item && typeof item === "object");
  if (content && typeof content === "object") return [content];
  return [{ type: "text", text: String(content || "") }];
}

function withCacheControlOnLastBlock(content) {
  const blocks = normalizeContentBlocks(content).map((block) => ({ ...block }));
  if (blocks.length === 0) return blocks;
  const lastIndex = blocks.length - 1;
  blocks[lastIndex] = {
    ...blocks[lastIndex],
    cache_control: { ...CACHE_CONTROL },
  };
  return blocks;
}

function buildClaudeSystemBlocks(opts = {}) {
  const blocks = [];
  const staticText = String(opts.staticText || opts.systemPrompt || opts.system || "").trim();
  const semistaticText = String(opts.semistaticText || opts.sessionPrompt || "").trim();
  const dynamicText = String(opts.dynamicText || "").trim();

  if (staticText) {
    blocks.push({
      type: "text",
      text: staticText,
      cache_control: { ...CACHE_CONTROL },
    });
  }
  if (semistaticText) {
    blocks.push({
      type: "text",
      text: semistaticText,
      cache_control: { ...CACHE_CONTROL },
    });
  }
  if (dynamicText) {
    blocks.push({
      type: "text",
      text: dynamicText,
    });
  }

  return blocks;
}

function buildClaudeRequestMessages(history = [], userMessage) {
  const prior = Array.isArray(history) ? history : [];
  const messages = prior.map((message) => ({
    role: String(message && message.role ? message.role : "user"),
    content: withCacheControlOnLastBlock(message && message.content ? message.content : []),
  }));
  messages.push(userMessage);
  return messages;
}

function buildClaudeRequest({
  model,
  maxTokens,
  messages = [],
  userMessage,
  tools = [],
  promptCache = {},
}) {
  const request = {
    model,
    max_tokens: maxTokens,
    messages: buildClaudeRequestMessages(messages, userMessage),
  };
  const system = buildClaudeSystemBlocks(promptCache);
  if (system.length > 0) request.system = system;
  if (tools.length > 0) request.tools = tools;
  return request;
}

function createAssistantMessageFromState(state) {
  return {
    role: "assistant",
    content: Array.isArray(state.assistantBlocks) ? state.assistantBlocks.slice() : [],
  };
}

function extraArgsToObject(extraArgs = []) {
  const result = {};
  if (!Array.isArray(extraArgs)) return result;
  for (let i = 0; i < extraArgs.length; i += 1) {
    const raw = String(extraArgs[i] || "");
    if (!raw.startsWith("--")) continue;
    const key = raw.replace(/^--+/, "");
    if (!key) continue;
    const next = i + 1 < extraArgs.length ? String(extraArgs[i + 1] || "") : "";
    if (!next || next.startsWith("--")) {
      result[key] = null;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function buildClaudeAgentOptions({
  model = "",
  cwd = "",
  threadId = "",
  extraArgs = [],
  agentOptions = {},
  opts = {},
} = {}) {
  const options = {
    ...agentOptions,
    ...(opts && typeof opts.agentOptions === "object" ? opts.agentOptions : {}),
  };
  if (model && options.model === undefined) options.model = model;
  if (cwd && options.cwd === undefined) options.cwd = cwd;
  if (options.includePartialMessages === undefined) options.includePartialMessages = true;
  if (options.extraArgs === undefined) {
    const converted = extraArgsToObject(extraArgs);
    if (Object.keys(converted).length > 0) options.extraArgs = converted;
  }
  if (threadId && !options.resume && !options.continue && !options.sessionId) {
    options.resume = threadId;
  }
  if (opts && opts.abortController && options.abortController === undefined) {
    options.abortController = opts.abortController;
  }
  if (opts && opts.signal && options.abortController === undefined) {
    const controller = new AbortController();
    opts.signal.addEventListener("abort", () => controller.abort(opts.signal.reason), { once: true });
    options.abortController = controller;
  }
  return options;
}

function messageTextFromContent(content = []) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" ? String(block.text || "") : ""))
    .join("");
}

function resultErrorMessage(message = {}) {
  if (Array.isArray(message.errors) && message.errors.length > 0) {
    return message.errors.map((item) => String(item || "")).filter(Boolean).join("\n");
  }
  if (typeof message.result === "string" && message.result) return message.result;
  if (message.subtype) return String(message.subtype);
  return "Claude Agent SDK query failed";
}

function shouldRetryClaudeStream(err, attempt) {
  if (attempt >= 1) return false;
  const code = String((err && err.code) || "").trim().toUpperCase();
  if (code === "ABORT_ERR" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  const message = String((err && err.message) || "").toLowerCase();
  return message.includes("stream") || message.includes("network") || message.includes("disconnect");
}

class ClaudeApiThread {
  constructor({
    model = "",
    cwd = "",
    extraArgs = [],
    authProvider = defaultClaudeAuthProvider,
    clientFactory = defaultClaudeClientFactory,
    streamFactory = defaultClaudeAgentStreamFactory,
    sdk,
    agentOptions = {},
    maxTokens = 4096,
  } = {}) {
    this.id = "";
    this.model = model;
    this.cwd = cwd;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs.slice() : [];
    this.authProvider = authProvider;
    this.clientFactory = clientFactory;
    this.streamFactory = streamFactory;
    this.sdk = sdk;
    this.agentOptions = { ...agentOptions };
    this.maxTokens = maxTokens;
    this.messages = [];
  }

  async *runStreamed(input, opts = {}) {
    if (this.streamFactory === defaultClaudeAgentStreamFactory) {
      yield* this.runAgentSdkStreamed(input, opts);
      return;
    }
    yield* this.runMessagesStreamed(input, opts);
  }

  async *runAgentSdkStreamed(input, opts = {}) {
    if (!this.sdk) {
      this.sdk = await resolveClaudeAgentSdk();
    }
    const options = buildClaudeAgentOptions({
      model: this.model,
      cwd: this.cwd,
      threadId: this.id,
      extraArgs: this.extraArgs,
      agentOptions: this.agentOptions,
      opts,
    });
    const stream = await this.streamFactory({
      sdk: this.sdk,
      input,
      options,
      model: this.model,
      cwd: this.cwd,
      threadId: this.id,
      opts,
    });
    const state = createClaudeEventState({ threadId: this.id });
    let threadStarted = false;
    let sawStreamEvents = false;
    let sawText = false;
    let sawTurnCompleted = false;

    const emitThreadStarted = function* emitThreadStarted(self, sessionId = "") {
      const nextId = String(sessionId || self.id || "").trim();
      if (nextId) self.id = nextId;
      if (!threadStarted && self.id) {
        threadStarted = true;
        yield redactUfooEvent({ type: "thread_started", threadId: self.id });
      }
    };

    for await (const message of stream) {
      if (!message || typeof message !== "object") continue;
      const sessionId = String(message.session_id || message.sessionId || "").trim();
      for (const event of emitThreadStarted(this, sessionId)) yield event;

      if (message.type === "stream_event") {
        sawStreamEvents = true;
        const events = normalizeClaudeEvent(message.event || {}, state);
        for (const event of events) {
          if (!event || typeof event !== "object") continue;
          if (event.type === "text_delta" && event.delta) sawText = true;
          if (event.type === "turn_completed") sawTurnCompleted = true;
          yield redactUfooEvent(event);
        }
        continue;
      }

      if (message.type === "assistant") {
        if (sawStreamEvents) continue;
        const events = normalizeClaudeMessage(message.message || {});
        for (const event of events) {
          if (!event || typeof event !== "object") continue;
          if (event.type === "text_delta" && event.delta) sawText = true;
          if (event.type === "turn_completed") sawTurnCompleted = true;
          yield redactUfooEvent(event);
        }
        continue;
      }

      if (message.type === "result") {
        if (message.is_error) {
          yield redactUfooEvent({
            type: "turn_failed",
            turnId: state.turnId || message.uuid || "",
            error: resultErrorMessage(message),
          });
          continue;
        }
        if (!sawText && typeof message.result === "string" && message.result) {
          sawText = true;
          yield redactUfooEvent({
            type: "text_delta",
            delta: message.result,
            itemType: "text",
          });
        }
        if (!sawTurnCompleted) {
          sawTurnCompleted = true;
          yield redactUfooEvent({
            type: "turn_completed",
            turnId: state.turnId || message.uuid || "",
            usage: normalizeClaudeUsage(message.usage || null),
            stopReason: String(message.stop_reason || ""),
          });
        }
      }
    }
  }

  async *runMessagesStreamed(input, opts = {}) {
    if (!this.id) this.id = createThreadId();
    const userMessage = normalizeMessageInput(input);
    const requestMessages = this.messages.slice();
    const tools = Array.isArray(opts.tools) ? opts.tools.map(normalizeToolDefinition).filter((tool) => tool.name) : [];
    const request = buildClaudeRequest({
      model: this.model,
      maxTokens: Number.isFinite(Number(opts.maxTokens)) ? Number(opts.maxTokens) : this.maxTokens,
      messages: requestMessages,
      userMessage,
      tools,
      promptCache: opts.promptCache || {},
    });

    yield redactUfooEvent({ type: "thread_started", threadId: this.id });

    const auth = await this.authProvider({ threadId: this.id, model: this.model });
    const client = this.clientFactory({
      sdk: this.sdk || resolveAnthropicSdk(),
      auth,
      model: this.model,
    });

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = createClaudeEventState({ threadId: this.id });
      try {
        const stream = await this.streamFactory({
          client,
          request,
          auth,
          attempt,
        });
        for await (const rawEvent of stream) {
          const events = normalizeClaudeEvent(rawEvent, state);
          for (const event of events) {
            if (event && typeof event === "object") {
              yield redactUfooEvent(event);
            }
          }
        }
        this.messages = requestMessages.concat([userMessage, createAssistantMessageFromState(state)]);
        return;
      } catch (err) {
        lastError = err;
        if (!shouldRetryClaudeStream(err, attempt)) {
          throw err;
        }
        // TODO(phase-1b-iii): if retry-after-partial-stream appears in practice,
        // add replay/dedupe before claude runner cutover. This slice retries only once.
      }
    }

    throw lastError || new Error("Claude stream failed");
  }

  async close() {
    return undefined;
  }
}

class ClaudeThreadProvider {
  constructor(options = {}) {
    this.options = { ...options };
  }

  startThread() {
    return new ClaudeApiThread(this.options);
  }

  resumeThread(threadId = "") {
    const thread = this.startThread();
    thread.id = String(threadId || "").trim();
    return thread;
  }
}

function createClaudeThreadProvider(options = {}) {
  return new ClaudeThreadProvider(options);
}

module.exports = {
  buildClaudeRequest,
  buildClaudeRequestMessages,
  buildClaudeSystemBlocks,
  ClaudeApiThread,
  ClaudeThreadProvider,
  createClaudeThreadProvider,
  buildClaudeAgentOptions,
  defaultClaudeAuthProvider,
  defaultClaudeAgentStreamFactory,
  defaultClaudeClientFactory,
  defaultClaudeStreamFactory,
  extraArgsToObject,
  normalizeMessageInput,
  normalizeToolDefinition,
  resolveClaudeAgentSdk,
  resolveAnthropicSdk,
  withCacheControlOnLastBlock,
};
