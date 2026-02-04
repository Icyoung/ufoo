const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

function collectJsonl(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines
    }
  }
  return items;
}

function collectJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString("utf8");
      stdout += chunk;
      if (options.onStdout) {
        options.onStdout(chunk);
      }
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString("utf8");
      stderr += chunk;
      if (options.onStderr) {
        options.onStderr(chunk);
      }
    });
    let timeout = null;
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        reject(new Error("CLI timeout"));
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

const DEFAULT_CLAUDE = {
  command: "claude",
  args: [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--json-schema",
    '{"type":"object","properties":{"reply":{"type":"string"},"dispatch":{"type":"array","items":{"type":"object","properties":{"target":{"type":"string"},"message":{"type":"string"}},"required":["target","message"]}},"ops":{"type":"array","items":{"type":"object","properties":{"action":{"type":"string"},"agent":{"type":"string"},"count":{"type":"integer"},"agent_id":{"type":"string"},"nickname":{"type":"string"}},"required":["action"]}},"disambiguate":{"type":"object","properties":{"prompt":{"type":"string"},"candidates":{"type":"array","items":{"type":"object","properties":{"agent_id":{"type":"string"},"reason":{"type":"string"}},"required":["agent_id"]}}}}},"required":["reply","dispatch","ops"]}',
  ],
  output: "json",
  input: "arg",
  modelArg: "--model",
  sessionArg: "--session-id",
  systemPromptArg: "--append-system-prompt",
};

const DEFAULT_CODEX = {
  command: "codex",
  args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
  output: "jsonl",
  input: "arg",
  modelArg: "--model",
  sessionArg: null,
  fallbackArgs: ["exec", "--json", "--color", "never", "--sandbox", "read-only"],
};

function buildArgs(backend, prompt, opts) {
  const args = [...(backend.args || [])];
  if (opts.model && backend.modelArg) {
    args.push(backend.modelArg, opts.model);
  }
  if (opts.sessionId && backend.sessionArg && !opts.disableSession) {
    args.push(backend.sessionArg, opts.sessionId);
  }
  if (opts.systemPrompt && backend.systemPromptArg) {
    args.push(backend.systemPromptArg, opts.systemPrompt);
  }
  if (backend.input === "arg") {
    args.push(prompt);
    return { args, stdin: "" };
  }
  return { args, stdin: prompt };
}

function isUnsupportedArgError(errText) {
  const text = (errText || "").toLowerCase();
  return text.includes("unknown option")
    || text.includes("unknown argument")
    || text.includes("unexpected argument")
    || text.includes("unrecognized option");
}

async function runCliAgent(params) {
  const backend = params.provider === "codex-cli" ? DEFAULT_CODEX : DEFAULT_CLAUDE;
  const sessionId = params.sessionId || randomUUID();
  const prompt =
    params.systemPrompt && !backend.systemPromptArg
      ? `${params.systemPrompt}\n\n${params.prompt}`
      : params.prompt;
  const { args, stdin } = buildArgs(backend, prompt, {
    model: params.model,
    sessionId,
    systemPrompt: params.systemPrompt,
    disableSession: params.disableSession,
  });

  let res;
  const env = { ...process.env, ...(params.env || {}) };
  delete env.CLAUDE_SESSION_ID;
  delete env.CODEX_SESSION_ID;
  try {
    res = await runCommand(backend.command, args, {
      cwd: params.cwd,
      env,
      input: stdin,
      timeoutMs: params.timeoutMs || 300000,  // 5 minutes for complex tasks
    });
  } catch (err) {
    return { ok: false, error: err.message || String(err), sessionId };
  }

  if (res.code !== 0) {
    const err = res.stderr || res.stdout || "CLI failed";
    if (backend === DEFAULT_CODEX && backend.fallbackArgs && isUnsupportedArgError(err)) {
      const retry = buildArgs(
        { ...backend, args: backend.fallbackArgs },
        prompt,
        {
          model: params.model,
          sessionId,
          systemPrompt: params.systemPrompt,
          disableSession: params.disableSession,
        },
      );
      try {
        res = await runCommand(backend.command, retry.args, {
          cwd: params.cwd,
          env,
          input: retry.stdin,
          timeoutMs: params.timeoutMs || 60000,
        });
      } catch (err2) {
        return { ok: false, error: err2.message || String(err2), sessionId };
      }
      if (res.code !== 0) {
        const err2 = res.stderr || res.stdout || "CLI failed";
        return { ok: false, error: err2, sessionId };
      }
    } else {
      return { ok: false, error: err, sessionId };
    }
  }

  if (backend.output === "jsonl") {
    return { ok: true, sessionId, output: collectJsonl(res.stdout) };
  }

  return { ok: true, sessionId, output: collectJson(res.stdout) };
}

module.exports = { runCliAgent };
