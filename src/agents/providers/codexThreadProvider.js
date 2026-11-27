const { createCodexEventState, normalizeCodexEvent } = require("./codexEventTranslator");
const { redactUfooEvent } = require("../../runtime/privacy/redactor");
const { loadAttachmentModelContext } = require("../../runtime/attachments");

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

function buildCodexOptions({ codexOptions = {}, mcpConfig = null } = {}) {
  const next = { ...codexOptions };
  if (mcpConfig && typeof mcpConfig === "object") {
    const existingConfig = next.config && typeof next.config === "object" ? next.config : {};
    const existingServers = existingConfig.mcp_servers && typeof existingConfig.mcp_servers === "object"
      ? existingConfig.mcp_servers
      : {};
    const injectedServers = mcpConfig.mcp_servers && typeof mcpConfig.mcp_servers === "object"
      ? mcpConfig.mcp_servers
      : {};
    next.config = {
      ...mcpConfig,
      ...existingConfig,
      mcp_servers: {
        ...injectedServers,
        ...existingServers,
      },
    };
  }
  return next;
}

function resolveCodexPermissionOptions(permissionMode = "") {
  const mode = String(permissionMode || "").trim().toLowerCase();
  if (mode === "supervised") {
    return { approvalPolicy: "on-request", sandboxMode: "workspace-write" };
  }
  if (mode === "auto_edit") {
    return { approvalPolicy: "on-failure", sandboxMode: "danger-full-access" };
  }
  return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
}

function buildThreadOptions({
  model = "",
  cwd = "",
  permissionMode = "",
  threadOptions = {},
} = {}) {
  const options = { ...threadOptions };
  const perm = resolveCodexPermissionOptions(permissionMode);
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
    options.sandboxMode = perm.sandboxMode;
  }
  if (options.approvalPolicy === undefined) {
    options.approvalPolicy = perm.approvalPolicy;
  }
  // SDK workspace-write disables sockets unless explicitly enabled. Coding
  // tools need local services too (ADB, Gradle, dev servers), not just HTTP.
  if (options.networkAccessEnabled === undefined) {
    options.networkAccessEnabled = true;
  }
  return options;
}

function buildTurnOptions(opts = {}) {
  const {
    history,
    tools,
    timeoutMs,
    runtimeContext,
    attachments,
    ...turnOptions
  } = opts || {};
  void history;
  void tools;
  void timeoutMs;
  void runtimeContext;
  void attachments;
  return turnOptions;
}

function buildCodexInput(input, opts = {}) {
  const text = String(input || "");
  const rawAttachments = Array.isArray(opts && opts.attachments) ? opts.attachments : [];
  if (rawAttachments.length === 0) return text;
  const ctx = loadAttachmentModelContext(rawAttachments, opts.cwd || "");
  if (!ctx.imagePaths || ctx.imagePaths.length === 0) return text;
  return [
    { type: "text", text },
    ...ctx.imagePaths.map((imgPath) => ({ type: "local_image", path: imgPath })),
  ];
}

async function* defaultCodexStreamFactory({
  thread,
  input,
  cwd = "",
  opts = {},
}) {
  if (!thread || typeof thread.runStreamed !== "function") {
    throw new Error("Codex SDK thread requires runStreamed support");
  }
  const codexInput = buildCodexInput(input, { ...opts, cwd });
  const streamed = await thread.runStreamed(codexInput, buildTurnOptions(opts));
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
    permissionMode = "",
    mcpConfig = null,
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
    this.permissionMode = String(permissionMode || "").trim();
    this.codexOptions = buildCodexOptions({ codexOptions, mcpConfig });
    this.threadOptions = { ...threadOptions };
    this.messages = [];
  }

  configure({ model, thinkingLevel, permissionMode } = {}) {
    let changed = false;
    if (model !== undefined) {
      const nextModel = String(model || "").trim();
      if (nextModel !== this.model) {
        this.model = nextModel;
        changed = true;
      }
    }
    if (thinkingLevel !== undefined) {
      const raw = String(thinkingLevel || "").trim().toLowerCase();
      const mapped = raw === "off" || raw === "none" ? "minimal"
        : raw === "max" ? "xhigh"
          : ["minimal", "low", "medium", "high", "xhigh"].includes(raw) ? raw : "";
      const nextOpts = { ...this.threadOptions };
      if (mapped) nextOpts.modelReasoningEffort = mapped;
      else delete nextOpts.modelReasoningEffort;
      if (nextOpts.modelReasoningEffort !== this.threadOptions.modelReasoningEffort) {
        this.threadOptions = nextOpts;
        changed = true;
      }
    }
    if (permissionMode !== undefined) {
      const nextPerm = String(permissionMode || "").trim().toLowerCase();
      if (nextPerm && nextPerm !== this.permissionMode) {
        this.permissionMode = nextPerm;
        changed = true;
      }
    }
    if (changed) {
      this.sdkThread = null;
    }
    return {
      model: this.model,
      thinkingLevel: String(this.threadOptions.modelReasoningEffort || ""),
      permissionMode: this.permissionMode,
    };
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
      permissionMode: this.permissionMode,
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
    const eventState = createCodexEventState();
    for await (const rawEvent of stream) {
      const normalized = normalizeCodexEvent(rawEvent, eventState);
      if (!normalized) continue;
      for (const item of Array.isArray(normalized) ? normalized : [normalized]) {
        if (item.type === "thread_started" && item.threadId) {
          this.id = item.threadId;
        }
        if (item.type === "text_delta" && item.delta) {
          outputText += item.delta;
        }
        yield redactUfooEvent(item);
      }
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
    permissionMode = "",
    mcpConfig = null,
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
    this.permissionMode = String(permissionMode || "").trim();
    this.codexOptions = buildCodexOptions({ codexOptions, mcpConfig });
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
      permissionMode: this.permissionMode,
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
      permissionMode: this.permissionMode,
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
  buildCodexOptions,
  buildThreadOptions,
  buildCodexInput,
  defaultCodexStreamFactory,
  resolveCodexSdk,
};
