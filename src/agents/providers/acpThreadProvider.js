"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { JsonRpcStdioConnection } = require("../acp/jsonRpcStdio");
const { translateAcpSessionUpdate, normalizeAcpUsage } = require("./acpEventTranslator");
const { resolveAcpAgentSpec } = require("./acpRegistry");
const { loadAttachmentModelContext } = require("../../runtime/attachments");

const ACP_PROTOCOL_VERSION = 1;

function isPathWithinRoot(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget === normalizedRoot
    || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function realpathOrNull(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function realpathNearestExisting(value) {
  let current = path.resolve(value);
  for (;;) {
    const real = realpathOrNull(current);
    if (real) return real;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const { resolveWorkspacePath } = require("../../code/tools/common");

function resolveSafeAcpWorkspacePath(cwd, targetPath) {
  const raw = String(targetPath || "").trim();
  if (!raw) throw new Error("Path is required");
  try {
    return resolveWorkspacePath(String(cwd || process.cwd()), raw).resolved;
  } catch (err) {
    if (err && /escapes workspace root/i.test(String(err.message || ""))) {
      throw new Error("Path outside workspace root");
    }
    throw err;
  }
}

function pickPermissionOption(options = [], preferredKinds = []) {
  const list = Array.isArray(options) ? options : [];
  for (const kind of preferredKinds) {
    const hit = list.find((opt) => String(opt.kind || "").toLowerCase() === kind);
    if (hit && hit.optionId) return hit.optionId;
  }
  return list[0]?.optionId || "";
}

function isWriteOrExecTool(toolCall = {}) {
  const kind = String(toolCall.kind || "").toLowerCase();
  const title = String(toolCall.title || toolCall.name || "").toLowerCase();
  if (["execute", "shell", "bash", "terminal", "delete", "remove"].some((k) => kind.includes(k) || title.includes(k))) {
    return "exec";
  }
  if (["edit", "write", "modify", "patch", "create"].some((k) => kind.includes(k) || title.includes(k))) {
    return "edit";
  }
  return "read";
}

function buildDefaultMcpServers(mcpServers = []) {
  if (!Array.isArray(mcpServers)) return [];
  return mcpServers.filter((item) => item && typeof item === "object");
}

function flattenConfigOptionValues(option = {}) {
  const out = [];
  const raw = Array.isArray(option.options) ? option.options : [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.options)) {
      for (const nested of item.options) {
        if (nested && nested.value !== undefined) out.push(String(nested.value));
      }
    } else if (item.value !== undefined) {
      out.push(String(item.value));
    }
  }
  return out;
}

function clampThoughtLevelToOptions(requested = "", allowedValues = []) {
  const raw = String(requested || "").trim().toLowerCase();
  if (!raw) return "";
  const allowed = Array.isArray(allowedValues) ? allowedValues.map((v) => String(v).toLowerCase()) : [];
  if (allowed.length === 0) return raw;
  const byLower = new Map(allowedValues.map((v) => [String(v).toLowerCase(), String(v)]));
  if (byLower.has(raw)) return byLower.get(raw);

  const fallbackOrder = {
    off: ["off", "none", "minimal", "low", "medium"],
    none: ["none", "off", "minimal", "low", "medium"],
    minimal: ["minimal", "low", "medium"],
    low: ["low", "minimal", "medium", "high"],
    medium: ["medium", "high", "low"],
    high: ["high", "xhigh", "medium", "low"],
    xhigh: ["xhigh", "max", "high", "medium"],
    max: ["max", "xhigh", "high", "medium"],
  };
  for (const candidate of fallbackOrder[raw] || [raw, "medium", "high", "low"]) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return allowedValues[0] ? String(allowedValues[0]) : "";
}

function resolveAcpModeId(permissionMode = "", availableModes = []) {
  const mode = String(permissionMode || "").trim().toLowerCase();
  const ids = (Array.isArray(availableModes) ? availableModes : [])
    .map((m) => String(typeof m === "string" ? m : (m?.id || m?.value || "")).trim())
    .filter(Boolean);
  if (ids.length === 0) return "";
  const byLower = new Map(ids.map((id) => [id.toLowerCase(), id]));
  const preferred = mode === "supervised"
    ? ["default", "ask", "plan"]
    : mode === "full_access"
      ? ["auto", "bypasspermissions", "accept-edits", "default"]
      : ["accept-edits", "auto", "default"];
  for (const candidate of preferred) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return "";
}

class AcpThread {
  constructor(options = {}) {
    this.agentId = String(options.agentId || "acp").trim();
    this.command = String(options.command || "").trim();
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
    this.env = options.env && typeof options.env === "object" ? { ...options.env } : {};
    this.cwd = String(options.cwd || process.cwd());
    this.mcpServers = buildDefaultMcpServers(options.mcpServers);
    this.model = String(options.model || "").trim();
    this.thinkingLevel = String(options.thinkingLevel || "").trim().toLowerCase();
    this.permissionMode = String(options.permissionMode || "auto_edit").trim().toLowerCase();
    this.systemPrompt = String(options.systemPrompt || "").trim();
    this.preferNativeSystemPrompt = Boolean(options.preferNativeSystemPrompt);
    this.managesSystemPrompt = Boolean(this.systemPrompt && this.preferNativeSystemPrompt);
    this._systemPromptApplied = false;
    this.onPermissionRequest = typeof options.onPermissionRequest === "function" ? options.onPermissionRequest : null;
    this.connectionFactory = typeof options.connectionFactory === "function" ? options.connectionFactory : null;
    this.sessionId = String(options.sessionId || "").trim();
    this.id = this.sessionId;
    this.child = null;
    this.conn = null;
    this.initialized = false;
    this.sessionReady = false;
    this.agentCapabilities = {};
    this.configOptions = [];
    this.availableModes = [];
    this.availableModels = [];
    this.activePush = null;
    this._announcedSessionId = "";
  }

  _ingestSessionMeta(res = {}) {
    if (!res || typeof res !== "object") return;
    if (Array.isArray(res.configOptions)) {
      this.configOptions = res.configOptions;
    }
    if (res.modes && Array.isArray(res.modes.availableModes)) {
      this.availableModes = res.modes.availableModes;
    }
    if (res.models && Array.isArray(res.models.availableModels)) {
      this.availableModels = res.models.availableModels;
    }
  }

  _findConfigOption(targetId = "") {
    const key = String(targetId || "").trim().toLowerCase();
    return (this.configOptions || []).find(
      (opt) => opt && (String(opt.id || "").toLowerCase() === key || String(opt.category || "").toLowerCase() === key)
    ) || null;
  }

  async _syncLiveConfig({ modelChanged = false, thinkingChanged = false, permissionChanged = false } = {}) {
    if (!this.conn || this.conn.closed || !this.sessionReady || !this.sessionId) return;

    if (permissionChanged && this.permissionMode) {
      const modeOpt = this._findConfigOption("mode");
      const candidates = modeOpt
        ? flattenConfigOptionValues(modeOpt)
        : this.availableModes;
      const modeId = resolveAcpModeId(this.permissionMode, candidates);
      if (modeId) {
        await this.conn.sendRequest("session/set_mode", {
          sessionId: this.sessionId,
          modeId,
        }, { timeoutMs: 5000 }).catch(() => {});
      }
    }

    if (modelChanged && this.model) {
      const modelOpt = this._findConfigOption("model");
      let applied = false;
      if (modelOpt) {
        const res = await this.conn.sendRequest("session/set_config_option", {
          sessionId: this.sessionId,
          configId: modelOpt.id || "model",
          value: this.model,
        }, { timeoutMs: 5000 }).catch(() => null);
        if (res) {
          if (Array.isArray(res.configOptions)) this.configOptions = res.configOptions;
          applied = true;
        }
      }
      if (!applied) {
        await this.conn.sendRequest("session/set_model", {
          sessionId: this.sessionId,
          modelId: this.model,
        }, { timeoutMs: 5000 }).catch(() => {});
      }
    }

    // Apply thinking level when explicitly requested (or when model slug doesn't encode a tier)
    const modelEncodesTier = /-(?:low|medium|high|xhigh|max)$/i.test(this.model);
    if (this.thinkingLevel && (thinkingChanged || (modelChanged && !modelEncodesTier))) {
      const thoughtOpt = this._findConfigOption("thought_level");
      if (thoughtOpt) {
        const allowed = flattenConfigOptionValues(thoughtOpt);
        const clamped = clampThoughtLevelToOptions(this.thinkingLevel, allowed);
        if (clamped && clamped !== String(thoughtOpt.currentValue || "")) {
          const res = await this.conn.sendRequest("session/set_config_option", {
            sessionId: this.sessionId,
            configId: thoughtOpt.id || "thought_level",
            value: clamped,
          }, { timeoutMs: 5000 }).catch(() => null);
          if (res && Array.isArray(res.configOptions)) {
            this.configOptions = res.configOptions;
          }
        }
      }
    }
  }

  async configure({ model, thinkingLevel, permissionMode } = {}) {
    const modelChanged = model !== undefined && String(model || "").trim() !== this.model;
    const thinkingChanged = thinkingLevel !== undefined
      && String(thinkingLevel || "").trim().toLowerCase() !== this.thinkingLevel;
    const permissionChanged = permissionMode !== undefined
      && String(permissionMode || "").trim().toLowerCase() !== this.permissionMode;

    if (model !== undefined) {
      this.model = String(model || "").trim();
      if (thinkingLevel === undefined) {
        const tierMatch = this.model.match(/-(low|medium|high|xhigh)$/i);
        if (tierMatch) {
          this.thinkingLevel = tierMatch[1].toLowerCase();
        }
      }
    }
    if (thinkingLevel !== undefined) {
      this.thinkingLevel = String(thinkingLevel || "").trim().toLowerCase();
    }
    if (permissionMode !== undefined) {
      const nextPerm = String(permissionMode || "").trim().toLowerCase();
      if (nextPerm) this.permissionMode = nextPerm;
    }

    await this._syncLiveConfig({ modelChanged, thinkingChanged, permissionChanged });

    if (modelChanged || thinkingChanged) {
      const thoughtOpt = this._findConfigOption("thought_level");
      if (thoughtOpt && thoughtOpt.currentValue) {
        this.thinkingLevel = String(thoughtOpt.currentValue).trim().toLowerCase();
      }
    }

    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      permissionMode: this.permissionMode,
    };
  }

  async _ensureConnection() {
    if (this.conn && !this.conn.closed && this.sessionReady) return this.conn;

    if (!this.conn || this.conn.closed) {
      this.initialized = false;
      this.sessionReady = false;
      if (this.connectionFactory) {
        const created = await this.connectionFactory({
          agentId: this.agentId,
          command: this.command,
          args: this.args,
          cwd: this.cwd,
          env: this.env,
        });
        this.conn = created.conn || created;
        this.child = created.child || null;
      } else {
        if (!this.command) {
          throw new Error(`ACP agent "${this.agentId}" has no configured executable command`);
        }
        this.child = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env, ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.conn = new JsonRpcStdioConnection({
          input: this.child.stdout,
          output: this.child.stdin,
        });
      }
      this._bindClientHandlers(this.conn);
    }

    if (!this.initialized) {
      const initRes = await this.conn.sendRequest("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: {
          name: "ufoo",
          version: require("../../../package.json").version,
        },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      }, { timeoutMs: 15000 });
      this.agentCapabilities = (initRes && initRes.agentCapabilities && typeof initRes.agentCapabilities === "object")
        ? initRes.agentCapabilities
        : {};
      this.initialized = true;
    }

    if (!this.sessionReady) {
      if (this.sessionId) {
        const canResume = Boolean(this.agentCapabilities?.sessionCapabilities?.resume);
        if (canResume) {
          try {
            const res = await this.conn.sendRequest("session/resume", {
              sessionId: this.sessionId,
              cwd: this.cwd,
              mcpServers: this.mcpServers,
            }, { timeoutMs: 15000 });
            this._ingestSessionMeta(res);
            this._systemPromptApplied = true;
            this.sessionReady = true;
          } catch {
            // Fall through to session/load or session/new.
          }
        }
        if (!this.sessionReady) {
          try {
            const res = await this.conn.sendRequest("session/load", {
              sessionId: this.sessionId,
              cwd: this.cwd,
              mcpServers: this.mcpServers,
            }, { timeoutMs: 15000 });
            this._ingestSessionMeta(res);
            this._systemPromptApplied = true;
            this.sessionReady = true;
          } catch {
            // Fall back to fresh session if agent does not support session/resume or session/load.
            this.sessionId = "";
          }
        }
      }
      if (!this.sessionReady) {
        const newParams = {
          cwd: this.cwd,
          mcpServers: this.mcpServers,
        };
        const supportsAgySystemPrompt = Boolean(this.agentCapabilities?._meta?.antigravity?.systemPrompt?.append);
        if (this.systemPrompt && supportsAgySystemPrompt) {
          newParams._meta = {
            antigravity: {
              systemPrompt: {
                append: this.systemPrompt,
              },
            },
          };
          this._systemPromptApplied = true;
        }
        const res = await this.conn.sendRequest("session/new", newParams, { timeoutMs: 15000 });
        this._ingestSessionMeta(res);
        this.sessionId = String(res?.sessionId || `acp-${this.agentId}-${Date.now().toString(36)}`);
        this.id = this.sessionId;
        this.sessionReady = true;
      }

      await this._syncLiveConfig({
        modelChanged: Boolean(this.model),
        thinkingChanged: Boolean(this.thinkingLevel) && !/-(?:low|medium|high|xhigh|max)$/i.test(this.model),
        permissionChanged: Boolean(this.permissionMode),
      });
    }

    return this.conn;
  }

  _bindClientHandlers(conn) {
    conn.onNotification("session/update", (params) => {
      const events = translateAcpSessionUpdate(params);
      for (const evt of events) {
        if (evt.type === "config_options") {
          this.configOptions = evt.configOptions;
          continue;
        }
        if (this.activePush) {
          this.activePush(evt);
        }
      }
    });

    conn.onRequest("session/request_permission", async (params = {}) => {
      const options = Array.isArray(params.options) ? params.options : [];
      const toolCall = params.toolCall || {};
      const risk = isWriteOrExecTool(toolCall);

      if (this.permissionMode === "full_access") {
        const optionId = pickPermissionOption(options, ["allow_always", "allow_once"]);
        return optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } };
      }

      if (this.permissionMode === "auto_edit" && (risk === "read" || risk === "edit")) {
        const optionId = pickPermissionOption(options, ["allow_once", "allow_always"]);
        return optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } };
      }

      if (this.onPermissionRequest) {
        const decision = await this.onPermissionRequest({
          sessionId: this.sessionId,
          toolCall,
          options,
          risk,
        });
        if (decision && decision.optionId) {
          return { outcome: { outcome: "selected", optionId: decision.optionId } };
        }
        if (decision && decision.allow) {
          const preferred = decision.always ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
          const optionId = pickPermissionOption(options, preferred);
          return optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        const rejectId = pickPermissionOption(options, ["reject_once", "reject_always"]);
        return rejectId
          ? { outcome: { outcome: "selected", optionId: rejectId } }
          : { outcome: { outcome: "cancelled" } };
      }

      // If no interactive approver is wired (e.g. headless background task), allow read-only and reject unsafe ops.
      if (risk === "read") {
        const optionId = pickPermissionOption(options, ["allow_once", "allow_always"]);
        return optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
      const rejectId = pickPermissionOption(options, ["reject_once", "reject_always"]);
      return rejectId
        ? { outcome: { outcome: "selected", optionId: rejectId } }
        : { outcome: { outcome: "cancelled" } };
    });

    conn.onRequest("fs/read_text_file", async (params = {}) => {
      const requested = resolveSafeAcpWorkspacePath(this.cwd, params.path);
      const raw = fs.readFileSync(requested, "utf8");
      if (Number.isInteger(params.line) || Number.isInteger(params.limit)) {
        const lines = raw.split(/\r?\n/);
        const start = Math.max(0, (Number(params.line) || 1) - 1);
        const end = params.limit ? start + Number(params.limit) : lines.length;
        return { content: lines.slice(start, end).join("\n") };
      }
      return { content: raw };
    });

    conn.onRequest("fs/write_text_file", async (params = {}) => {
      const requested = resolveSafeAcpWorkspacePath(this.cwd, params.path);
      if (this.permissionMode === "supervised") {
        if (!this.onPermissionRequest) {
          throw new Error("Permission denied: supervised mode requires approval for fs/write_text_file");
        }
        const decision = await this.onPermissionRequest({
          sessionId: this.sessionId,
          toolCall: {
            name: "fs/write_text_file",
            title: `Write ${String(params.path || "")}`,
            kind: "edit",
            rawInput: { path: String(params.path || "") },
          },
          options: [
            { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject_once", kind: "reject_once", name: "Reject" },
          ],
          risk: "edit",
        });
        const approved = Boolean(
          decision && (
            decision.allow === true
            || decision.optionId === "allow_once"
            || decision.optionId === "allow_always"
          )
        );
        if (!approved) {
          throw new Error("Permission denied: user rejected fs/write_text_file");
        }
      }
      fs.mkdirSync(path.dirname(requested), { recursive: true });
      // Re-verify canonical realpath right before writing to guard against symlink races
      const verified = resolveSafeAcpWorkspacePath(this.cwd, params.path);
      fs.writeFileSync(verified, String(params.content ?? ""), "utf8");
      return {};
    });
  }

  async *runStreamed(input, opts = {}) {
    const conn = await this._ensureConnection();
    const queue = [];
    let wake = null;
    let done = false;
    let failure = null;
    let accumulatedText = "";

    const push = (event) => {
      if (event.type === "text_delta" && event.delta) {
        accumulatedText += event.delta;
      }
      queue.push(event);
      if (wake) {
        wake();
        wake = null;
      }
    };

    this.activePush = push;

    const onAbort = () => {
      if (this.sessionId && conn && !conn.closed) {
        conn.sendNotification("session/cancel", { sessionId: this.sessionId });
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (this.sessionId && this._announcedSessionId !== this.sessionId) {
      this._announcedSessionId = this.sessionId;
      push({ type: "thread_started", threadId: this.sessionId });
    }
    push({ type: "turn_started" });

    let promptText = String(input || "");
    if (this.managesSystemPrompt && this.systemPrompt && !this._systemPromptApplied) {
      // Fallback when server did not advertise native systemPrompt.append
      promptText = [this.systemPrompt, promptText].filter(Boolean).join("\n\n");
      this._systemPromptApplied = true;
    }

    const promptBlocks = [];
    if (
      Array.isArray(opts.attachments)
      && opts.attachments.length > 0
      && this.agentCapabilities?.promptCapabilities?.image === true
    ) {
      try {
        const attCtx = loadAttachmentModelContext(opts.attachments, this.cwd);
        for (const img of attCtx.visionPayloads || []) {
          if (img && img.base64) {
            promptBlocks.push({
              type: "image",
              data: img.base64,
              mimeType: img.mediaType || "image/png",
            });
          }
        }
      } catch {
        // Fallback cleanly to text appendix already included in promptText
      }
    }
    promptBlocks.push({ type: "text", text: promptText });

    const promptPromise = conn.sendRequest("session/prompt", {
      sessionId: this.sessionId,
      prompt: promptBlocks,
    }, { signal: opts.signal }).then((result) => {
      const normalizedUsage = normalizeAcpUsage(result?.usage);
      push({
        type: "turn_completed",
        stopReason: result?.stopReason || "end_turn",
        usage: normalizedUsage,
        ...(accumulatedText ? { finalText: accumulatedText } : {}),
      });
    }).catch((err) => {
      failure = err;
    }).finally(() => {
      done = true;
      this.activePush = null;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (wake) {
        wake();
        wake = null;
      }
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift();
        } else {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
      }
      await promptPromise;
      if (failure) throw failure;
    } finally {
      this.activePush = null;
    }
  }

  async close() {
    this.activePush = null;
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.child = null;
    }
    this.initialized = false;
    this.sessionReady = false;
  }
}

function createAcpThreadProvider(options = {}) {
  const cwd = String(options.cwd || process.cwd());
  const spec = options.command
    ? {
        id: String(options.agentId || "custom"),
        command: options.command,
        args: Array.isArray(options.args) ? options.args : [],
        env: options.env || {},
      }
    : resolveAcpAgentSpec(options.agentId || options.provider || "", cwd);

  if (!spec) {
    throw new Error(`Unknown ACP agent: ${options.agentId || options.provider || "(empty)"}`);
  }

  const base = {
    agentId: spec.id,
    command: spec.command,
    args: spec.args,
    env: { ...(spec.env || {}), ...(options.env || {}) },
    cwd,
    mcpServers: options.mcpServers || [],
    model: options.model || "",
    thinkingLevel: options.thinkingLevel || "",
    permissionMode: options.permissionMode || "auto_edit",
    systemPrompt: options.systemPrompt || "",
    preferNativeSystemPrompt: Boolean(options.preferNativeSystemPrompt),
    onPermissionRequest: options.onPermissionRequest,
    connectionFactory: options.connectionFactory,
  };

  return {
    spec,
    startThread() {
      return new AcpThread({ ...base, sessionId: "" });
    },
    resumeThread(sessionId = "") {
      return new AcpThread({ ...base, sessionId: String(sessionId || "").trim() });
    },
  };
}

module.exports = {
  ACP_PROTOCOL_VERSION,
  AcpThread,
  createAcpThreadProvider,
  clampThoughtLevelToOptions,
  resolveAcpModeId,
  resolveSafeAcpWorkspacePath,
};
