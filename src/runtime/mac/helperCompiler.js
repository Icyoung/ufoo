"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const lockfile = require("proper-lockfile");
const {
  macBinDir,
  macPrivateDir,
  macCompileLockPath,
  swiftHelperSourcePath,
} = require("./paths");

const SWIFTC_FRAMEWORKS = [
  "-framework", "AppKit",
  "-framework", "ApplicationServices",
  "-framework", "CoreGraphics",
  "-framework", "ImageIO",
  "-framework", "UniformTypeIdentifiers",
];

function computeHelperSourceHash(sourcePath = swiftHelperSourcePath()) {
  const content = fs.readFileSync(sourcePath);
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function resolveCachedHelperBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  sourcePath = swiftHelperSourcePath(),
} = {}) {
  const override = String(env.UFOO_MAC_HELPER_BIN || "").trim();
  if (override) {
    const resolved = path.resolve(override);
    return {
      binaryPath: resolved,
      hash: "override",
      exists: fs.existsSync(resolved),
      overridden: true,
    };
  }
  if (platform !== "darwin") {
    return { binaryPath: "", hash: "", exists: false, overridden: false };
  }
  const hash = computeHelperSourceHash(sourcePath);
  const binaryPath = path.join(macBinDir(env), `ufoo-mac-helper-${arch}-${hash}`);
  let exists = false;
  try {
    const st = fs.statSync(binaryPath);
    exists = st.isFile() && st.size > 0;
  } catch {
    exists = false;
  }
  return { binaryPath, hash, exists, overridden: false };
}

function detectSwiftCompiler({ spawnSyncImpl = spawnSync, env = process.env } = {}) {
  const custom = String(env.UFOO_SWIFTC_BIN || "").trim();
  const cmd = custom || "swiftc";
  const res = spawnSyncImpl(cmd, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    env,
  });
  if (res.status === 0) {
    const firstLine = String(res.stdout || "").split(/\r?\n/)[0] || "";
    return { available: true, command: cmd, version: firstLine.trim() };
  }
  return {
    available: false,
    command: cmd,
    version: "",
    error: (res.error && res.error.message) || String(res.stderr || "swiftc not found").trim(),
  };
}

function pruneOldHelperBinaries(binDir, keepFilename) {
  try {
    for (const entry of fs.readdirSync(binDir)) {
      if (!entry.startsWith("ufoo-mac-helper-")) continue;
      if (entry === keepFilename || entry.includes(".tmp-")) continue;
      try {
        fs.unlinkSync(path.join(binDir, entry));
      } catch {
        // Ignore busy or already-removed binaries
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

function spawnCompileAsync(cmd, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false, error: "swiftc compilation timed out after 90s" });
    }, 90000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `swiftc exited with code ${code}` });
    });
  });
}

async function ensureHelperCompiled({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  sourcePath = swiftHelperSourcePath(),
  compileImpl = spawnCompileAsync,
  detectCompilerImpl = detectSwiftCompiler,
} = {}) {
  if (platform !== "darwin") {
    throw Object.assign(
      new Error(`macOS app automation is only supported on darwin (current: ${platform}).`),
      { code: "unsupported_platform" },
    );
  }
  const cached = resolveCachedHelperBinary({ env, platform, arch, sourcePath });
  if (cached.exists) {
    return { ok: true, compiled: false, binaryPath: cached.binaryPath, hash: cached.hash };
  }
  if (cached.overridden) {
    throw Object.assign(
      new Error(`Configured UFOO_MAC_HELPER_BIN does not exist: ${cached.binaryPath}`),
      { code: "helper_missing" },
    );
  }

  fs.mkdirSync(macPrivateDir(env), { recursive: true, mode: 0o700 });
  fs.mkdirSync(macBinDir(env), { recursive: true, mode: 0o700 });

  const lockTarget = macCompileLockPath(env);
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 120000,
    update: 10000,
    retries: { retries: 20, minTimeout: 100, maxTimeout: 500 },
  });

  try {
    const recheck = resolveCachedHelperBinary({ env, platform, arch, sourcePath });
    if (recheck.exists) {
      return { ok: true, compiled: false, binaryPath: recheck.binaryPath, hash: recheck.hash };
    }

    const compiler = detectCompilerImpl({ env });
    if (!compiler.available) {
      throw Object.assign(
        new Error("Apple Swift compiler (`swiftc`) is not available. Install Xcode Command Line Tools with `xcode-select --install` and retry."),
        { code: "swiftc_missing" },
      );
    }

    const tempOut = `${recheck.binaryPath}.tmp-${process.pid}-${Date.now()}`;
    const args = [
      "-O",
      "-swift-version", "5",
      "-parse-as-library",
      sourcePath,
      "-o", tempOut,
      ...SWIFTC_FRAMEWORKS,
    ];
    const build = await compileImpl(compiler.command, args, { env });
    if (!build.ok) {
      try { fs.unlinkSync(tempOut); } catch {}
      throw Object.assign(
        new Error(`Failed to build native macOS helper: ${build.error}`),
        { code: "helper_compile_failed" },
      );
    }
    fs.chmodSync(tempOut, 0o755);
    fs.renameSync(tempOut, recheck.binaryPath);
    pruneOldHelperBinaries(macBinDir(env), path.basename(recheck.binaryPath));
    return { ok: true, compiled: true, binaryPath: recheck.binaryPath, hash: recheck.hash };
  } finally {
    await release().catch(() => {});
  }
}

async function runHelperCheck({
  env = process.env,
  platform = process.platform,
  prompt = false,
  openSettings = false,
  ensureCompiledImpl = ensureHelperCompiled,
  spawnSyncImpl = spawnSync,
} = {}) {
  const compiled = await ensureCompiledImpl({ env, platform });
  const args = ["check"];
  if (prompt) args.push("--prompt");
  if (openSettings) args.push("--open-settings");
  const res = spawnSyncImpl(compiled.binaryPath, args, {
    encoding: "utf8",
    timeout: 10000,
    env,
  });
  if (res.status !== 0) {
    throw Object.assign(
      new Error(String(res.stderr || res.error?.message || "ufoo-mac-helper check failed").trim()),
      { code: "helper_check_failed" },
    );
  }
  const parsed = JSON.parse(String(res.stdout || "{}").trim() || "{}");
  return {
    ...parsed.status,
    binaryPath: compiled.binaryPath,
    binaryHash: compiled.hash,
    compiledNow: compiled.compiled,
  };
}

module.exports = {
  computeHelperSourceHash,
  resolveCachedHelperBinary,
  detectSwiftCompiler,
  ensureHelperCompiled,
  runHelperCheck,
};
