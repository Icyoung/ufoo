"use strict";

const { execFile } = require("child_process");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const DEFAULT_AGY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const AGY_SETUP_HINT = "Sign in with `agy`, or set UFOO_AGY_ACCESS_TOKEN or UFOO_AGY_AUTH_PATH.";
const CLOUD_CODE_ORIGINS = new Set([
  DEFAULT_AGY_BASE_URL,
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
]);
const KEYRING_ENCODING = "go-keyring-base64:";
const execFileAsync = (...args) => promisify(execFile)(...args);
let refreshInFlight;
let projectCache;

function parseLocalLogin(raw) {
  try {
    const text = raw.trim();
    const entry = JSON.parse(text.startsWith(KEYRING_ENCODING)
      ? Buffer.from(text.slice(KEYRING_ENCODING.length), "base64").toString("utf8")
      : text);
    return { accessToken: String(entry.token?.access_token || "").trim(), expiresAt: String(entry.token?.expiry || "") };
  } catch {
    throw new Error("Unable to read the local agy login. Sign in again with `agy`.");
  }
}

async function readLocalLogin({ homeDir, platform, runCommand }) {
  const options = { timeout: 20000, maxBuffer: 128 * 1024 };
  if (platform === "darwin") {
    try {
      const { stdout } = await runCommand("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], options);
      return { ...parseLocalLogin(stdout), source: "agy macOS Keychain" };
    } catch (error) {
      if (error.code !== 44) {
        throw new Error("Unable to read the agy Keychain item. Allow access in macOS or configure UFOO_AGY_AUTH_PATH.");
      }
    }
  }
  if (platform === "linux") {
    try {
      const { stdout } = await runCommand("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], options);
      if (stdout.trim()) return { ...parseLocalLogin(stdout), source: "agy Secret Service" };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== 1) {
        throw new Error("Unable to read the agy Secret Service item. Unlock the keyring or configure UFOO_AGY_AUTH_PATH.");
      }
    }
  }
  let raw;
  try {
    raw = await fs.promises.readFile(path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read the local agy auth file.");
  }
  return { ...parseLocalLogin(raw), source: "agy auth file" };
}

function expiryIsDue(expiresAt) {
  return Date.parse(expiresAt) <= Date.now() + 30000;
}

async function refreshLocalLogin(options) {
  if (!refreshInFlight) {
    const installed = path.join(options.homeDir, ".local", "bin", "agy");
    const command = fs.existsSync(installed) ? installed : "agy";
    refreshInFlight = Promise.resolve().then(() => options.runCommand(command, ["models"], {
      cwd: os.tmpdir(), env: { ...options.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      timeout: 20000, maxBuffer: 256 * 1024,
    })).catch(() => {
      throw new Error("Antigravity login needs renewal. Open `agy` and check your sign-in.");
    }).finally(() => { refreshInFlight = null; });
  }
  await refreshInFlight;
  return readLocalLogin(options);
}

function buildAgyHeaders({ accessToken, userAgent }) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  };
}

async function discoverAgyProject({ baseUrl, credential, fetchImpl, signal }) {
  const origin = new URL(baseUrl).origin;
  const key = createHash("sha256").update(origin).update("\0").update(credential.accessToken).digest("hex");
  if (projectCache?.key === key && projectCache.expiresAt > Date.now()) return projectCache.projectId;

  const timeout = AbortSignal.timeout(8000);
  const response = await fetchImpl(`${origin}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: buildAgyHeaders(credential),
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Antigravity project lookup failed (HTTP ${response.status}). Check your sign-in with \`agy\`.`);
  }
  const payload = await response.json();
  const project = payload.cloudaicompanionProject || payload.projectId || payload.project;
  const projectId = typeof project === "string" ? project.trim() : String(project?.id || "").trim();
  if (!projectId) throw new Error("Antigravity did not return a Cloud Code project. Open `agy` to finish account setup.");
  projectCache = { key, projectId, expiresAt: Date.now() + 10 * 60 * 1000 };
  return projectId;
}

async function resolveAgyCredentials({
  apiKey = "", env = process.env, homeDir = os.homedir(), platform = process.platform,
  runCommand = execFileAsync, fetchImpl = global.fetch, baseUrl = env.UFOO_AGY_BASE_URL || DEFAULT_AGY_BASE_URL,
  signal, requireProject = true,
} = {}) {
  const explicitToken = String(apiKey || env.UFOO_AGY_ACCESS_TOKEN || "").trim();
  const authPath = String(env.UFOO_AGY_AUTH_PATH || "").trim();
  let credential;
  let projectId = String(env.UFOO_AGY_PROJECT_ID || "").trim();
  let storedUserAgent = "";
  if (explicitToken) {
    credential = { accessToken: explicitToken, expiresAt: "", source: "configured access token" };
  } else if (authPath) {
    let data;
    try {
      const file = authPath.startsWith("~/") ? path.join(homeDir, authPath.slice(2)) : authPath;
      data = JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch {
      throw new Error("Cannot read Antigravity auth JSON from UFOO_AGY_AUTH_PATH.");
    }
    if (data?.type !== "antigravity" || data.disabled === true) {
      throw new Error("UFOO_AGY_AUTH_PATH must point to an enabled Antigravity auth file.");
    }
    credential = { accessToken: String(data.access_token || "").trim(),
      expiresAt: String(data.expired || "").trim(), source: "Antigravity auth file" };
    projectId ||= String(data.project_id || "").trim();
    storedUserAgent = data.user_agent;
  } else {
    if (!CLOUD_CODE_ORIGINS.has(new URL(baseUrl).origin)) {
      throw new Error("Set explicit Antigravity credentials for the configured API URL.");
    }
    const options = { env, homeDir, platform, runCommand };
    credential = await readLocalLogin(options);
    if (credential?.accessToken && requireProject && expiryIsDue(credential.expiresAt)) {
      credential = await refreshLocalLogin(options);
    }
  }
  if (!credential?.accessToken) {
    throw Object.assign(new Error(`Antigravity API credentials are missing. ${AGY_SETUP_HINT}`),
      { code: "AGY_CREDENTIALS_MISSING" });
  }
  if (Date.parse(credential.expiresAt) <= Date.now()) {
    throw new Error("Antigravity access token expired. Renew it with the client that manages it.");
  }
  credential.userAgent = String(env.UFOO_AGY_USER_AGENT || storedUserAgent || "antigravity/hub/2.32.1 darwin/arm64").trim();
  if (!projectId && requireProject) {
    if (!CLOUD_CODE_ORIGINS.has(new URL(baseUrl).origin)) {
      throw new Error("Set UFOO_AGY_PROJECT_ID for the configured Antigravity API URL.");
    }
    projectId = await discoverAgyProject({ baseUrl, credential, fetchImpl, signal });
  }
  return { ...credential, projectId };
}

module.exports = { DEFAULT_AGY_BASE_URL, AGY_SETUP_HINT, resolveAgyCredentials, buildAgyHeaders };
