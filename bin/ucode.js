#!/usr/bin/env node
/**
 * ucode: Launch ufoo self-developed coding agent core
 *
 * Usage: ucode [core args...]
 *
 * Command resolution order:
 * 1) UFOO_UCODE_CMD / UFOO_UFOO_CODE_CMD
 * 2) .ufoo/config.json -> ucodeCommand / ufooCodeCommand
 * 3) fallback: bundled native core entry
 */

const fs = require("fs");
const AgentLauncher = require("../src/agents/launch/launcher");
const { resolveUcodeLaunch } = require("../src/code/launcher/ucode");
const { prepareUcodeBootstrap } = require("../src/code/launcher/ucodeBootstrap");
const { prepareUcodeRuntimeConfig } = require("../src/code/launcher/ucodeRuntimeConfig");

function stripAppendSystemPromptArgs(args = [], targetFile = "") {
  const normalizedTarget = String(targetFile || "").trim();
  if (!Array.isArray(args) || args.length === 0) return { args: [], removed: false };
  const nextArgs = [];
  let removed = false;
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || "");
    if (!item) continue;
    if (item === "--append-system-prompt") {
      const value = String(args[i + 1] || "");
      if (!normalizedTarget || value === normalizedTarget) {
        removed = true;
        i += 1;
        continue;
      }
      nextArgs.push(item, value);
      i += 1;
      continue;
    }
    if (item.startsWith("--append-system-prompt=")) {
      const value = item.slice("--append-system-prompt=".length);
      if (!normalizedTarget || value === normalizedTarget) {
        removed = true;
        continue;
      }
    }
    nextArgs.push(item);
  }
  return { args: nextArgs, removed };
}

function shouldPreserveAppendTarget({
  appendTarget = "",
  bootstrapFile = "",
} = {}) {
  const append = String(appendTarget || "").trim();
  if (!append) return false;
  const bootstrap = String(bootstrapFile || "").trim();
  if (!bootstrap) return fs.existsSync(append);
  if (append === bootstrap) return false;
  return fs.existsSync(append);
}

function extractUfooParamsFromArgs(args = []) {
  const nextArgs = [];
  let nickname = "";
  let role = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    if (arg === "--nickname") {
      if (i + 1 < args.length) {
        nickname = String(args[i + 1]).trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--nickname=")) {
      nickname = arg.slice("--nickname=".length).trim();
      continue;
    }
    if (arg === "--role") {
      if (i + 1 < args.length) {
        role = String(args[i + 1]).trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--role=")) {
      role = arg.slice("--role=".length).trim();
      continue;
    }
    nextArgs.push(args[i]);
  }
  return { args: nextArgs, nickname, role };
}

const { args: cleanArgs, nickname, role } = extractUfooParamsFromArgs(process.argv.slice(2));
if (nickname) {
  process.env.UFOO_NICKNAME = nickname;
}
if (role) {
  process.env.UFOO_PROMPT_PROFILE = role;
}

const resolved = resolveUcodeLaunch({
  argv: cleanArgs,
  env: process.env,
  cwd: process.cwd(),
});

if (resolved && resolved.env && typeof resolved.env === "object") {
  for (const [key, value] of Object.entries(resolved.env)) {
    if (!key) continue;
    process.env[key] = String(value);
  }
}

try {
  const runtimePrepared = prepareUcodeRuntimeConfig({
    projectRoot: process.cwd(),
    env: process.env,
  });
  if (runtimePrepared && runtimePrepared.env && typeof runtimePrepared.env === "object") {
    for (const [key, value] of Object.entries(runtimePrepared.env)) {
      if (!key) continue;
      process.env[key] = String(value);
    }
  }
} catch {
  // runtime config preparation is best-effort
}

try {
  prepareUcodeBootstrap({
    projectRoot: process.cwd(),
    promptFile: process.env.UFOO_UCODE_PROMPT_FILE || "",
    targetFile: process.env.UFOO_UCODE_BOOTSTRAP_FILE || "",
  });
} catch (err) {
  const mode = String(process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE || "auto").trim().toLowerCase();
  const bootstrapFile = String(process.env.UFOO_UCODE_BOOTSTRAP_FILE || "").trim();
  const appendTarget = String(process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT || bootstrapFile).trim();
  const preserveCustomAppend = shouldPreserveAppendTarget({ appendTarget, bootstrapFile });
  if (mode !== "always" && !preserveCustomAppend) {
    const stripped = stripAppendSystemPromptArgs(resolved.args, appendTarget);
    resolved.args = stripped.args;
    if (stripped.removed) {
      console.error(`[ucode] Warning: bootstrap prepare failed; launching without --append-system-prompt (${err && err.message ? err.message : "unknown error"})`);
    }
  } else if (preserveCustomAppend) {
    console.error(`[ucode] Warning: bootstrap prepare failed; preserving custom --append-system-prompt (${err && err.message ? err.message : "unknown error"})`);
  }
}

const mode = String(process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE || "auto").trim().toLowerCase();
const bootstrapFile = String(process.env.UFOO_UCODE_BOOTSTRAP_FILE || "").trim();
const appendTarget = String(process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT || bootstrapFile).trim();
const preserveCustomAppend = shouldPreserveAppendTarget({ appendTarget, bootstrapFile });
if (mode !== "always" && bootstrapFile && !fs.existsSync(bootstrapFile) && !preserveCustomAppend) {
  const stripped = stripAppendSystemPromptArgs(resolved.args, appendTarget);
  resolved.args = stripped.args;
  if (stripped.removed) {
    console.error("[ucode] Warning: bootstrap file missing; launching without --append-system-prompt");
  }
}

const launcher = new AgentLauncher(resolved.agentType, resolved.command);
launcher.launch(resolved.args);
