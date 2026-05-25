const { loadConfig } = require("../../config");
const path = require("path");
const fs = require("fs");

function bundledModuleRoots() {
  return [
    path.join(__dirname, ".."),
  ];
}

function resolveFirstExisting(paths = []) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return "";
}

function defaultBundledCoreRoot() {
  const root = path.join(__dirname, "..");
  const agentEntry = path.join(root, "agent.js");
  if (resolveFirstExisting([agentEntry])) return root;
  return root;
}

function defaultBundledPromptFile() {
  const moduleRoots = bundledModuleRoots();
  const candidates = moduleRoots.map((root) => path.join(root, "UCODE_PROMPT.md"));
  return resolveFirstExisting(candidates) || candidates[0];
}

function isWindowsPlatform() {
  return process.platform === "win32";
}

function canExecutePath(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return false;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return false;
    if (isWindowsPlatform()) return true;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isReadableFile(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return false;
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function resolveExecutableFromPath(command = "", env = process.env) {
  const text = String(command || "").trim();
  if (!text) return "";
  if (path.isAbsolute(text) || text.includes("/") || text.includes("\\")) {
    return canExecutePath(text) ? path.resolve(text) : "";
  }

  const pathText = String((env && env.PATH) || process.env.PATH || "").trim();
  if (!pathText) return "";
  const dirs = pathText.split(path.delimiter).map((item) => String(item || "").trim()).filter(Boolean);
  if (dirs.length === 0) return "";

  const hasExplicitExt = /\.[a-zA-Z0-9]+$/.test(text);
  const exts = isWindowsPlatform()
    ? String((env && env.PATHEXT) || process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
    : [""];
  const suffixes = hasExplicitExt ? [""] : exts;

  for (const dir of dirs) {
    for (const ext of suffixes) {
      const candidate = path.join(dir, `${text}${ext}`);
      if (canExecutePath(candidate)) return candidate;
    }
  }
  return "";
}

function tokenizeCommand(raw = "") {
  const text = String(raw || "");
  const tokens = [];
  let current = "";
  let quote = "";

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === "\"") {
        if (ch === "\\") {
          if (i + 1 < text.length) {
            const next = text[i + 1];
            if (next === "\"" || next === "\\") {
              current += next;
              i += 1;
              continue;
            }
          }
          current += "\\";
          continue;
        }
      } else if (quote === "'" && ch === "\\") {
        current += "\\";
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < text.length) {
        const next = text[i + 1];
        if (/\s/.test(next) || next === "'" || next === "\"" || next === "\\") {
          current += next;
          i += 1;
        } else {
          current += "\\";
        }
      } else {
        current += "\\";
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) {
    return String(raw || "").trim().split(/\s+/).filter(Boolean);
  }
  if (current) tokens.push(current);
  return tokens;
}

function splitCommand(raw, fallback = "pi") {
  const text = String(raw || "").trim();
  if (!text) return { command: fallback, args: [] };
  const parts = tokenizeCommand(text);
  if (parts.length === 0) return { command: fallback, args: [] };
  return { command: parts[0], args: parts.slice(1) };
}

function hasAnyArg(args = [], names = []) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const flags = new Set((Array.isArray(names) ? names : []).filter(Boolean));
  return args.some((arg) => {
    const text = String(arg || "").trim();
    if (!text) return false;
    if (flags.has(text)) return true;
    const eqIdx = text.indexOf("=");
    if (eqIdx <= 0) return false;
    const key = text.slice(0, eqIdx).trim();
    return flags.has(key);
  });
}

function pickBinEntry(binField = {}) {
  if (typeof binField === "string" && binField.trim()) {
    return binField.trim();
  }
  if (!binField || typeof binField !== "object") return "";
  const entries = Object.entries(binField)
    .filter(([, value]) => typeof value === "string" && value.trim());
  if (entries.length === 0) return "";
  const preferred = entries.find(([name]) => /^(ucode|core|cli)$/i.test(String(name)));
  if (preferred) return preferred[1].trim();
  return entries[0][1].trim();
}

function normalizeAppendSystemPromptMode(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "always" || text === "force" || text === "on" || text === "1" || text === "true") return "always";
  if (text === "never" || text === "off" || text === "0" || text === "false" || text === "disable") return "never";
  return "auto";
}

function isLikelyPiCoreCommand(command = "", args = []) {
  const cmdText = String(command || "").trim();
  const cmdBase = path.basename(cmdText).toLowerCase();
  if (cmdBase === "ucode" || cmdBase === "ucode.exe") return true;

  const joined = [cmdText, ...(Array.isArray(args) ? args : [])]
    .map((part) => String(part || "").toLowerCase())
    .join(" ");
  if (!joined) return false;
  if (joined.includes("/src/code/agent.js")) return true;
  if (joined.includes("\\src\\code\\agent.js")) return true;
  return false;
}

function readLastArgValue(args = [], flag = "") {
  if (!Array.isArray(args) || !flag) return "";
  let value = "";
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || "").trim();
    if (!item) continue;
    if (item === flag) {
      const next = String(args[i + 1] || "").trim();
      if (next) value = next;
      i += 1;
      continue;
    }
    if (item.startsWith(`${flag}=`)) {
      const inlineValue = item.slice(flag.length + 1).trim();
      if (inlineValue) value = inlineValue;
    }
  }
  return value;
}

function resolveCoreFromPath(coreRoot = "") {
  const requestedRoot = String(coreRoot || "").trim();
  if (!requestedRoot) return null;
  let stat;
  try {
    stat = fs.statSync(requestedRoot);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const candidates = [
    requestedRoot,
    path.join(requestedRoot, "packages", "coding-agent"),
  ];

  for (const root of candidates) {
    const packageFile = path.join(root, "package.json");
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    } catch {
      continue;
    }
    const binRel = pickBinEntry(pkg && pkg.bin ? pkg.bin : {});
    if (!binRel) continue;
    const binAbs = path.resolve(root, binRel);
    if (!fs.existsSync(binAbs)) continue;
    return {
      command: process.execPath,
      args: [binAbs],
      root,
    };
  }
  return null;
}

function resolveCandidateCoreRoot({
  env = process.env,
  config = {},
} = {}) {
  // Native-only mode: external pi-mono path is no longer used as launch fallback.
  // Keep function for compatibility with older diagnostic surfaces.
  void env;
  void config;
  return null;
}

function resolveNativeFallbackCommand({ env = process.env } = {}) {
  void env;
  const entry = path.resolve(__dirname, "..", "agent.js");
  try {
    if (isReadableFile(entry)) {
      return {
        command: process.execPath,
        args: [entry],
        root: path.resolve(__dirname, ".."),
        kind: "native",
        available: true,
        resolvedPath: entry,
      };
    }
  } catch {
    // ignore
  }
  return {
    command: process.execPath,
    args: [entry],
    root: path.resolve(__dirname, ".."),
    kind: "native",
    available: false,
    resolvedPath: "",
    missingReason: "src/code/agent.js not found",
  };
}

function resolveUcodeLaunch({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  loadConfigImpl = loadConfig,
} = {}) {
  const config = loadConfigImpl(cwd);
  const configuredProvider = String(
    env.UFOO_UCODE_PROVIDER
      || config.ucodeProvider
      || ""
  ).trim();
  const configuredModel = String(
    env.UFOO_UCODE_MODEL
      || config.ucodeModel
      || ""
  ).trim();

  const nativeCore = resolveNativeFallbackCommand({ env });
  const command = nativeCore.command;
  const baseArgs = Array.isArray(nativeCore.args) ? nativeCore.args.slice() : [];
  const passthrough = Array.isArray(argv) ? argv.slice() : [];
  const finalArgs = [...baseArgs, ...passthrough];
  const hasProviderArg = hasAnyArg(finalArgs, ["--provider"]);
  const hasModelArg = hasAnyArg(finalArgs, ["--model"]);
  if (!hasProviderArg && configuredProvider) finalArgs.push("--provider", configuredProvider);
  if (!hasModelArg && configuredModel) finalArgs.push("--model", configuredModel);
  const promptFile = String(
    env.UFOO_UCODE_PROMPT_FILE
      || config.ucodePromptFile
      || defaultBundledPromptFile()
  ).trim();
  const bootstrapFile = String(
    env.UFOO_UCODE_BOOTSTRAP_FILE
      || config.ucodeBootstrapFile
      || path.join(cwd || process.cwd(), ".ufoo", "agent", "ucode", "bootstrap.md")
  ).trim();
  const appendSystemPrompt = String(
    env.UFOO_UCODE_APPEND_SYSTEM_PROMPT
      || config.ucodeAppendSystemPrompt
      || bootstrapFile
  ).trim();
  const appendSystemPromptMode = normalizeAppendSystemPromptMode(
    env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE
      || config.ucodeAppendSystemPromptMode
      || "auto"
  );
  const hasSystemPromptArg = hasAnyArg(finalArgs, ["--system-prompt", "--append-system-prompt"]);
  const appendSupported = appendSystemPromptMode === "always"
    || (
      appendSystemPromptMode === "auto"
      && (
        nativeCore.kind === "native"
        || isLikelyPiCoreCommand(command, finalArgs)
      )
    );
  if (!hasSystemPromptArg && appendSystemPrompt && appendSystemPromptMode !== "never" && appendSupported) {
    finalArgs.push("--append-system-prompt", appendSystemPrompt);
  }
  const effectiveProvider = readLastArgValue(finalArgs, "--provider");
  const effectiveModel = readLastArgValue(finalArgs, "--model");

  return {
    agentType: "ufoo-code",
    command,
    args: finalArgs,
    env: {
      UFOO_UCODE_PROMPT_FILE: promptFile,
      UFOO_UCODE_PROJECT_ROOT: String(cwd || process.cwd()),
      UFOO_UCODE_MODE: "coding-agent",
      UFOO_UCODE_PROTOCOL_VERSION: "1",
      UFOO_UCODE_PROVIDER: effectiveProvider,
      UFOO_UCODE_MODEL: effectiveModel,
      UFOO_UCODE_CORE_ROOT: nativeCore.root || "",
      UFOO_UCODE_CORE_KIND: "native",
      UFOO_UCODE_CORE_AVAILABLE: nativeCore.available === false ? "0" : "1",
      UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
      UFOO_UCODE_APPEND_SYSTEM_PROMPT: appendSystemPrompt,
      UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: appendSystemPromptMode,
    },
  };
}

module.exports = {
  bundledModuleRoots,
  defaultBundledCoreRoot,
  defaultBundledPromptFile,
  tokenizeCommand,
  splitCommand,
  hasAnyArg,
  pickBinEntry,
  normalizeAppendSystemPromptMode,
  isLikelyPiCoreCommand,
  readLastArgValue,
  resolveCoreFromPath,
  resolveCandidateCoreRoot,
  canExecutePath,
  resolveExecutableFromPath,
  resolveNativeFallbackCommand,
  resolveUcodeLaunch,
};
