const { normalizeCodexEvent } = require("./codexEventTranslator");
const { redactUfooEvent } = require("../providerapi/redactor");

async function resolveCodexSdk() {
  try {
    return await import("@openai/codex-sdk");
  } catch (err) {
    const error = new Error("Codex SDK mode requires @openai/codex-sdk");
    error.code = "CODEX_SDK_UNAVAILABLE";
    error.cause = err;
    throw error;
  }
}

function resolveCodexConstructor(sdk) {
  const Codex = sdk && (sdk.Codex || (sdk.default && sdk.default.Codex) || sdk.default);
  if (typeof Codex !== "function") {
    throw new Error("Codex SDK module does not export Codex");
  }
  return Codex;
}

function buildCodexOptions({ codexOptions = {} } = {}) {
  return { ...codexOptions };
}

function buildThreadOptions({
  model = "",
  cwd = "",
  threadOptions = {},
} = {}) {
  const options = { ...threadOptions };
  if (model && options.model === undefined) {
    options.model = model;
  }
  if (cwd && options.workingDirectory === undefined) {
    options.workingDirectory = cwd;
  }
  if (options.skipGitRepoCheck === undefined) {
    options.skipGitRepoCheck = true;
  }
  if (options.sandboxMode === undefined) {
    options.sandboxMode = "workspace-write";
  }
  return options;
}

function buildTurnOptions(opts = {}) {
  const {
    history,
    tools,
    timeoutMs,
    ...turnOptions
  } = opts || {};
  void history;
  void tools;
  void timeoutMs;
  return turnOptions;
}

async function* defaultCodexStreamFactory({
  thread,
  input,
  opts = {},
}) {
  if (!thread || typeof thread.runStreamed !== "function") {
    throw new Error("Codex SDK thread requires runStreamed support");
  }
  const streamed = await thread.runStreamed(String(input || ""), buildTurnOptions(opts));
  const events = streamed && streamed.events ? streamed.events : streamed;
  if (!events || typeof events[Symbol.asyncIterator] !== "function") {
    throw new Error("Codex SDK runStreamed did not return an async event stream");
  }
  for await (const event of events) {
    yield event;
  }
}

class CodexSdkThread {
  constructor({
    model = "",
    cwd = "",
    extraArgs = [],
    streamFactory = defaultCodexStreamFactory,
    sdk,
    codexClient,
    sdkThread,
    threadId = "",
    tools = [],
    codexOptions = {},
    threadOptions = {},
  } = {}) {
    this.id = String(threadId || "").trim();
    this.model = model;
    this.cwd = cwd;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs.slice() : [];
    this.streamFactory = streamFactory;
    this.sdk = sdk;
    this.codexClient = codexClient || null;
    this.sdkThread = sdkThread || null;
    this.tools = Array.isArray(tools) ? tools.slice() : [];
    this.codexOptions = buildCodexOptions({ codexOptions });
    this.threadOptions = { ...threadOptions };
    this.messages = [];
  }

  async getCodexClient() {
    if (this.codexClient) return this.codexClient;
    if (!this.sdk) {
      this.sdk = await resolveCodexSdk();
    }
    const Codex = resolveCodexConstructor(this.sdk);
    this.codexClient = new Codex(this.codexOptions);
    return this.codexClient;
  }

  async getSdkThread() {
    if (this.sdkThread) return this.sdkThread;
    const client = await this.getCodexClient();
    const options = buildThreadOptions({
      model: this.model,
      cwd: this.cwd,
      threadOptions: this.threadOptions,
    });
    this.sdkThread = this.id && typeof client.resumeThread === "function"
      ? client.resumeThread(this.id, options)
      : client.startThread(options);
    if (this.sdkThread && this.sdkThread.id) {
      this.id = this.sdkThread.id;
    }
    return this.sdkThread;
  }

  async *runStreamed(input, opts = {}) {
    const mergedOpts = { ...opts };
    if (this.tools.length > 0 && !Array.isArray(mergedOpts.tools)) {
      mergedOpts.tools = this.tools.slice();
    }
    mergedOpts.history = this.messages.slice();
    const sdkThread = this.streamFactory === defaultCodexStreamFactory
      ? await this.getSdkThread()
      : this.sdkThread;
    const stream = this.streamFactory({
      sdk: this.sdk,
      thread: sdkThread,
      codexClient: this.codexClient,
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
    if (sdkThread && sdkThread.id) {
      this.id = sdkThread.id;
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
    codexClient,
    tools = [],
    codexOptions = {},
    threadOptions = {},
  } = {}) {
    this.model = model;
    this.cwd = cwd;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs.slice() : [];
    this.streamFactory = streamFactory;
    this.sdk = sdk || null;
    this.codexClient = codexClient || null;
    this.tools = Array.isArray(tools) ? tools.slice() : [];
    this.codexOptions = buildCodexOptions({ codexOptions });
    this.threadOptions = { ...threadOptions };
  }

  startThread() {
    return new CodexSdkThread({
      model: this.model,
      cwd: this.cwd,
      extraArgs: this.extraArgs,
      streamFactory: this.streamFactory,
      sdk: this.sdk,
      codexClient: this.codexClient,
      tools: this.tools,
      codexOptions: this.codexOptions,
      threadOptions: this.threadOptions,
    });
  }

  resumeThread(threadId = "") {
    return new CodexSdkThread({
      model: this.model,
      cwd: this.cwd,
      extraArgs: this.extraArgs,
      streamFactory: this.streamFactory,
      sdk: this.sdk,
      codexClient: this.codexClient,
      threadId,
      tools: this.tools,
      codexOptions: this.codexOptions,
      threadOptions: this.threadOptions,
    });
  }
}

function createCodexThreadProvider(options = {}) {
  return new CodexThreadProvider(options);
}

module.exports = {
  CodexSdkThread,
  CodexThreadProvider,
  createCodexThreadProvider,
  buildThreadOptions,
  defaultCodexStreamFactory,
  resolveCodexSdk,
};
