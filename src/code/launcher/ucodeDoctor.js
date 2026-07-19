const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../../config");
const {
  resolveNativeFallbackCommand,
} = require("./ucode");
const { inspectUcodeBuildSetup } = require("./ucodeBuild");
const { inspectUcodeRuntimeConfig } = require("./ucodeRuntimeConfig");
const { prepareUcodeBootstrap } = require("./ucodeBootstrap");

function inspectUcodeSetup({
  projectRoot = process.cwd(),
  env = process.env,
  loadConfigImpl = loadConfig,
  resolveNativeImpl = resolveNativeFallbackCommand,
} = {}) {
  const root = path.resolve(projectRoot);
  const config = loadConfigImpl(root);
  const native = resolveNativeImpl({ env, config, cwd: root });
  const coreAvailable = Boolean(native && native.available !== false && native.command);
  const core = native ? {
    root: native.root || path.resolve(__dirname, ".."),
    command: native.command,
    args: native.args || [],
    available: coreAvailable,
    missingReason: String(native.missingReason || "").trim(),
    resolvedPath: String(native.resolvedPath || "").trim(),
  } : null;
  const promptFile = String(
    env.UFOO_UCODE_PROMPT_FILE
      || config.ucodePromptFile
      || ""
  ).trim();
  const bootstrapFile = String(
    env.UFOO_UCODE_BOOTSTRAP_FILE
      || config.ucodeBootstrapFile
      || path.join(root, ".ufoo", "agent", "ucode", "bootstrap.md")
  ).trim();
  const build = inspectUcodeBuildSetup({
    projectRoot: root,
    env,
    loadConfigImpl,
  });
  const runtime = inspectUcodeRuntimeConfig({
    projectRoot: root,
    env,
    loadConfigImpl,
  });
  let importMeta = null;
  if (core && core.root) {
    const candidates = [
      path.join(core.root, ".ufoo-import.json"),
      path.join(core.root, "..", ".ufoo-import.json"),
      path.join(core.root, "..", "..", ".ufoo-import.json"),
      path.join(core.root, "..", "..", "..", ".ufoo-import.json"),
    ].map((item) => path.resolve(item));
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (parsed && typeof parsed === "object") {
          importMeta = {
            file: candidate,
            importedAt: String(parsed.imported_at || "").trim(),
            upstreamCommit: String(parsed.upstream_commit || "").trim(),
            upstreamBranch: String(parsed.upstream_branch || "").trim(),
            upstreamRemote: String(parsed.upstream_remote || "").trim(),
          };
          break;
        }
      } catch {
        // ignore malformed metadata
      }
    }
  }

  return {
    projectRoot: root,
    expectedBundledCoreRoot: core ? core.root : "",
    core: {
      found: Boolean(core && core.available),
      root: core ? core.root : "",
      command: core ? core.command : "",
      args: core ? core.args : [],
      available: Boolean(core && core.available),
      missingReason: core ? core.missingReason : "",
      resolvedPath: core ? core.resolvedPath : "",
    },
    promptFile,
    promptExists: Boolean(promptFile && fs.existsSync(promptFile)),
    bootstrapFile,
    build,
    runtime,
    importMeta,
    configuredCommand: String(
      env.UFOO_UCODE_CMD
        || env.UFOO_UFOO_CODE_CMD
        || config.ucodeCommand
        || config.ufooCodeCommand
        || ""
    ).trim(),
  };
}

function formatUcodeDoctor(result = {}) {
  const lines = [];
  lines.push("=== ucode doctor ===");
  lines.push(`project: ${result.projectRoot || process.cwd()}`);
  lines.push(`core: ${result.core && result.core.found ? "ready" : "missing"}`);
  if (result.core && result.core.found) {
    lines.push(`  root: ${result.core.root}`);
    lines.push(`  launch: ${result.core.command} ${(result.core.args || []).join(" ")}`.trim());
    if (result.core.resolvedPath) {
      lines.push(`  resolved path: ${result.core.resolvedPath}`);
    }
  } else {
    if (result.expectedBundledCoreRoot) {
      lines.push(`  expected bundled root: ${result.expectedBundledCoreRoot}`);
    }
    if (result.core && result.core.command) {
      lines.push(`  attempted launch: ${result.core.command} ${(result.core.args || []).join(" ")}`.trim());
    }
    if (result.core && result.core.missingReason) {
      lines.push(`  missing reason: ${result.core.missingReason}`);
    } else {
      lines.push("  missing reason: native executable is unavailable");
    }
  }
  if (result.configuredCommand) {
    lines.push(`configured command override (ignored in native-only mode): ${result.configuredCommand}`);
  }
  lines.push(`prompt: ${result.promptFile || "(none)"}${result.promptFile && !result.promptExists ? " (missing)" : ""}`);
  lines.push(`bootstrap: ${result.bootstrapFile || "(none)"}`);
  if (result.build && result.build.coreRoot) {
    lines.push(`build: ${result.build.distCliExists ? "ready" : "missing dist"}`);
    lines.push(`  core root: ${result.build.coreRoot}`);
    lines.push(`  workspace root: ${result.build.workspaceRoot || "(none)"}`);
    lines.push(`  dist entry: ${result.build.distCliPath || "(none)"}${result.build.distCliExists ? "" : " (missing)"}`);
  } else {
    lines.push("build: unresolved core root");
  }
  if (result.importMeta) {
    lines.push(`import metadata: ${result.importMeta.file || "(unknown)"}`);
    lines.push(`  imported at: ${result.importMeta.importedAt || "(unknown)"}`);
    lines.push(`  upstream commit: ${result.importMeta.upstreamCommit || "(unknown)"}`);
    lines.push(`  upstream branch: ${result.importMeta.upstreamBranch || "(unknown)"}`);
    lines.push(`  upstream remote: ${result.importMeta.upstreamRemote ? "(set)" : "(unset)"}`);
  }
  if (result.runtime) {
    lines.push(`runtime: ${result.runtime.agentDir || "(none)"}`);
    lines.push(`  provider: ${result.runtime.provider || "(unset)"}`);
    lines.push(`  model: ${result.runtime.model || "(unset)"}`);
    lines.push(`  base url: ${result.runtime.baseUrl ? "(set)" : "(unset)"}`);
    lines.push(`  api key: ${result.runtime.apiKey ? "(set)" : "(unset)"}`);
  }
  if (!(result.core && result.core.found) && !result.configuredCommand) {
    lines.push("hint: verify native entry exists at src/code/agent.js");
  }
  return lines.join("\n");
}

function prepareAndInspectUcode({
  projectRoot = process.cwd(),
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  const inspection = inspectUcodeSetup({ projectRoot, env, loadConfigImpl });
  const prepared = prepareUcodeBootstrap({
    projectRoot: inspection.projectRoot,
    promptFile: inspection.promptFile,
    targetFile: inspection.bootstrapFile,
    // The native core already injects the ufoo protocol via the modular
    // prompt (src/agents/prompts/native/ufoo.js); inlining it into the
    // bootstrap file would append the same protocol text a second time.
    includeDefaultProtocol: false,
  });
  return {
    ...inspection,
    bootstrapPrepared: prepared,
  };
}

module.exports = {
  inspectUcodeSetup,
  formatUcodeDoctor,
  prepareAndInspectUcode,
};
