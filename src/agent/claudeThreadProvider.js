"use strict";

const {
  createClaudeEventState,
  normalizeClaudeEvent,
} = require("./claudeEventTranslator");
const { redactUfooEvent } = require("../providerapi/redactor");
const { sendUpstreamRequest } = require("./upstreamTransport");

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

async function* defaultClaudeTransportStreamFactory({ request, auth = {}, model = "", attempt = 0 }) {
  const runtime = {
    provider: "claude",
    transport: "anthropic-messages",
    model: String(model || request.model || "").trim(),
    baseUrl: String(auth.baseUrl || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").trim(),
    auth,
    credentialSource: auth.apiKey ? "thread-auth" : "thread-headers",
  };
  const result = await sendUpstreamRequest({
    runtime,
    request,
    timeoutMs: Number.isFinite(Number(request.timeout_ms)) ? Number(request.timeout_ms) : 120000,
  });
  if (!result.ok) {
    const err = new Error(result.error || "Claude upstream request failed");
    err.code = "CLAUDE_UPSTREAM_FAILED";
    err.attempt = attempt;
    throw err;
  }

  yield {
    type: "message_start",
    message: {
      id: `msg-${Date.now().toString(36)}`,
      usage: result.usage || undefined,
    },
  };
  yield {
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "text_delta",
      text: String(result.output || ""),
    },
  };
  yield { type: "message_stop" };
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
    authProvider = defaultClaudeAuthProvider,
    clientFactory = defaultClaudeClientFactory,
    streamFactory = defaultClaudeStreamFactory,
    sdk,
    maxTokens = 4096,
  } = {}) {
    this.id = "";
    this.model = model;
    this.authProvider = authProvider;
    this.clientFactory = clientFactory;
    this.streamFactory = streamFactory;
    this.sdk = sdk;
    this.maxTokens = maxTokens;
    this.messages = [];
  }

  async *runStreamed(input, opts = {}) {
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
  defaultClaudeAuthProvider,
  defaultClaudeClientFactory,
  defaultClaudeStreamFactory,
  defaultClaudeTransportStreamFactory,
  normalizeMessageInput,
  normalizeToolDefinition,
  resolveAnthropicSdk,
  withCacheControlOnLastBlock,
};
