"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const lockfile = require("proper-lockfile");
const { loadGlobalBrowserConfig, saveGlobalBrowserConfig } = require("../../config");
const { setupLockPath } = require("../../runtime/browser/paths");
const {
  runBrowserInstall,
  formatStatusLines,
} = require("./browserCommands");

const FIRST_RUN_SKIP_COMMANDS = new Set([
  "setup",
  "browser",
  "daemon",
  "mcp",
  "agent-runner",
  "doctor",
  "status",
  "project",
  "init",
  "skills",
  "group",
  "solo",
  "online",
  "bus",
  "ctx",
  "history",
  "trace",
  "metrics",
  "report",
  "recover",
  "ucode",
]);

function renderChoicePromptLines() {
  return [
    "",
    "选择可选组件",
    "",
    "[ ] ufoo Browser",
    "    让 ufoo / ucode 操作日常 Chrome 中已登录的网页。",
    "    启用后自动连接本机 ufoo，无需填写 key 或逐次确认连接。",
    "",
  ];
}

function askYesNo(promptText, { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdout?.isTTY) });
    rl.question(promptText, (answer) => {
      rl.close();
      const norm = String(answer || "").trim().toLowerCase();
      resolve(norm === "y" || norm === "yes" || norm === "install" || norm === "1");
    });
  });
}

function parseBrowserFlag(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "install" || raw === "enable" || raw === "yes") return "install";
  if (raw === "skip" || raw === "no" || raw === "disable") return "skip";
  throw new Error(`Invalid --browser value "${value}". Expected "install" or "skip".`);
}

async function runSetupCommand(opts = {}, {
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  write = (line) => console.log(line),
  writeError = (line) => console.error(line),
  promptYesNo = askYesNo,
  installImpl = runBrowserInstall,
} = {}) {
  const outputJson = opts.json === true;
  let choice = "";
  try {
    choice = parseBrowserFlag(opts.browser || "");
  } catch (err) {
    const msg = err.message || String(err);
    if (outputJson) write(JSON.stringify({ ok: false, error: msg }, null, 2));
    else writeError(msg);
    return { ok: false, exitCode: 1, error: msg };
  }

  const interactive = Boolean(stdin?.isTTY && stdout?.isTTY && !env.CI && !outputJson);
  if (!choice) {
    if (!interactive) {
      // Non-interactive setup (including --yes) defaults to skipping browser install.
      choice = "skip";
    } else {
      for (const line of renderChoicePromptLines()) write(line);
      const accepted = await promptYesNo("是否安装并启用 ufoo Browser？[y/N]: ", { stdin, stdout });
      choice = accepted ? "install" : "skip";
    }
  }

  if (choice === "skip") {
    const config = saveGlobalBrowserConfig({
      setupChoice: "skip",
      enabled: false,
    });
    const payload = { ok: true, choice: "skip", state: "not_installed", config };
    if (outputJson) write(JSON.stringify(payload, null, 2));
    else write("已跳过 ufoo Browser，完成 ufoo 基础配置。稍后可随时运行 `ufoo browser install`。");
    return { ...payload, exitCode: 0 };
  }

  const installRes = await installImpl({
    dev: opts.dev === true,
    sourceDir: opts.source || "",
    tarball: opts.tarball || "",
    sha256: opts.sha256 || "",
    openStore: opts.noOpen !== true && interactive,
    env,
  });

  if (outputJson) {
    write(JSON.stringify({ choice: "install", ...installRes }, null, 2));
  } else if (!installRes.ok) {
    writeError(installRes.error || "ufoo Browser setup failed");
  } else {
    for (const line of formatStatusLines(installRes.status)) write(line);
  }
  return {
    choice: "install",
    ...installRes,
    exitCode: installRes.ok ? 0 : 1,
  };
}

function shouldOfferFirstRunSetup({ surface = "ufoo", argv = [], env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (env.UFOO_SKIP_FIRST_RUN_SETUP === "1") return false;
  if (env.CI) return false;
  if (!stdin?.isTTY || !stdout?.isTTY) return false;
  if (env.UFOO_DAEMON_CHILD === "1" || env.UFOO_INTERNAL_AGENT === "1" || env.UFOO_BROWSER_BROKER_CHILD === "1") return false;
  if (env.UFOO_SUBSCRIBER_ID) return false;

  const args = Array.isArray(argv) ? argv.map((v) => String(v || "").trim()) : [];
  if (args.some((arg) => ["--help", "-h", "--version", "-V", "--json", "-p", "--print"].includes(arg))) {
    return false;
  }
  if (surface === "ufoo") {
    const nonFlag = args.find((arg) => arg && !arg.startsWith("-"));
    if (nonFlag && FIRST_RUN_SKIP_COMMANDS.has(nonFlag) && nonFlag !== "chat") return false;
  }
  const cfg = loadGlobalBrowserConfig();
  return cfg.setupChoice === "unset";
}

/**
 * On the very first interactive launch of `ufoo` or `ucode`, ask once whether to install ufoo Browser.
 * Protected by a user-level setup lock so concurrent first launches only prompt once.
 */
async function maybeRunFirstTimeSetup(options = {}) {
  if (!shouldOfferFirstRunSetup(options)) return { prompted: false };
  const env = options.env || process.env;
  const lockFile = setupLockPath(env);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await lockfile.lock(lockFile, {
      realpath: false,
      stale: 300000,
      update: 10000,
      retries: { retries: 3, minTimeout: 100, maxTimeout: 300 },
    });
  } catch (error) {
    if (error && error.code === "ELOCKED") return { prompted: false, locked: true };
    throw error;
  }
  try {
    if (loadGlobalBrowserConfig().setupChoice !== "unset") {
      return { prompted: false };
    }
    const result = await runSetupCommand({}, {
      env,
      stdin: options.stdin || process.stdin,
      stdout: options.stdout || process.stdout,
      write: options.write,
      writeError: options.writeError,
      promptYesNo: options.promptYesNo,
      installImpl: options.installImpl,
    });
    return { prompted: true, result };
  } finally {
    await release().catch(() => {});
  }
}

module.exports = {
  renderChoicePromptLines,
  parseBrowserFlag,
  runSetupCommand,
  shouldOfferFirstRunSetup,
  maybeRunFirstTimeSetup,
};
