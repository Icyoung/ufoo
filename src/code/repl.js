const readline = require("readline");
const { runToolCall, TOOL_NAMES } = require("./dispatch");
const {
  runUcodeTui,
  shouldUseUcodeTui,
  buildUcodeBannerLines,
  StreamBuffer,
  createEscapeTagStripper,
  stripLeakedEscapeTags,
} = require("./tui");
const { stripBlessedTags } = require("../app/chat/text");
const { resolveSessionId } = require("./sessionStore");
const {
  formatSkillsList,
  listUcodeSkills,
  showSkill,
} = require("./skills");
const {
  runUbusCommand,
  resolveUfooProjectRoot,
  getPendingBusCount,
  shouldAutoConsumeBus,
} = require("./busConsumer");
const { summarizeSessionUsage, formatSessionUsageStatus } = require("./usageStore");
const { listUcodeCommandsForHelp } = require("./commands");
const { applyUcodeModelCommand, suggestUcodeModels } = require("./modelCommand");
const { applyUcodePlanCommand } = require("./context/planMode");

function printPrompt(stdout = process.stdout) {
  stdout.write("> ");
}

function printUcodeBanner(stdout = process.stdout, {
  model = "",
  workspaceRoot = process.cwd(),
  sessionId = "",
  planMode = false,
} = {}) {
  stdout.write(`${buildUcodeBannerLines({
    model,
    engine: "ufoo-core",
    workspaceRoot,
    sessionId,
    planMode,
    width: (stdout && stdout.columns) || 0,
  }).join("\n")}\n`);
}

function normalizeLine(input = "") {
  return String(input || "").trim();
}

function parseLegacyUfooMarkerCommand(input = "") {
  const text = String(input || "").trim();
  if (!text) return "";
  // Old daemons injected strict "<prefix> <single-token>" commands for
  // session discovery. Keep ignoring those inputs after removing injection.
  const match = text.match(/^(?:\$ufoo|\/ufoo|ufoo)\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/);
  return match ? String(match[1] || "").trim() : "";
}

function parseJson(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

function extractAgentNickname(agentId = "") {
  // Extract nickname from agent ID like "ufoo-agent:abc123" -> "ufoo"
  const id = String(agentId || "").trim();
  if (!id) return "";

  // Remove the instance ID part (after colon)
  const base = id.split(":")[0];

  // Common agent nickname mappings
  if (base === "ufoo-agent") return "ufoo";
  if (base === "claude-code") return "claude";
  if (base === "ufoo-code") return "ucode";

  // Return base name as-is for others
  return base;
}

function runSingleCommand(line = "", workspaceRoot = process.cwd()) {
  const text = normalizeLine(line);
  if (!text) return { kind: "empty" };
  if (text === "exit" || text === "quit" || text === "/exit" || text === "/quit") return { kind: "exit" };
  if (text === "help" || text === "/help") {
    return {
      kind: "help",
      output: listUcodeCommandsForHelp(),
    };
  }
  const legacyUfooMarker = parseLegacyUfooMarkerCommand(text);
  if (legacyUfooMarker) {
    return {
      kind: "legacy_ufoo_marker",
      marker: legacyUfooMarker,
    };
  }
  if (text === "ubus" || text === "/ubus") {
    return {
      kind: "ubus",
    };
  }
  if (text === "status" || text === "/status") {
    return {
      kind: "status",
    };
  }
  const modelMatch = text.match(/^(?:\/model|model)(?:\s+(.*))?$/i);
  if (modelMatch) {
    const nextModel = String(modelMatch[1] || "").trim();
    if (!nextModel) {
      return { kind: "model", action: "show" };
    }
    // Reject accidental multi-token garbage; model ids are single tokens.
    if (/\s/.test(nextModel)) {
      return {
        kind: "error",
        output: "usage: /model [model-id]",
      };
    }
    return {
      kind: "model",
      action: "set",
      model: nextModel,
    };
  }
  const planMatch = text.match(/^(?:\/plan|plan)(?:\s+(.*))?$/i);
  if (planMatch) {
    const arg = String(planMatch[1] || "").trim().toLowerCase();
    if (!arg || arg === "show" || arg === "status") return { kind: "plan", action: "show" };
    if (arg === "on" || arg === "enable") return { kind: "plan", action: "on" };
    if (arg === "off" || arg === "disable") return { kind: "plan", action: "off" };
    if (arg === "clear") return { kind: "plan", action: "clear" };
    if (arg === "hide") return { kind: "plan", action: "hide" };
    if (arg === "focus") return { kind: "plan", action: "focus" };
    if (arg === "debug") return { kind: "plan", action: "debug" };
    if (arg === "toggle") return { kind: "plan", action: "toggle" };
    return {
      kind: "error",
      output: "usage: /plan [on|off|show|hide|focus|debug|clear]",
    };
  }
  const skillsMatch = text.match(/^(?:\/skills|skills)(?:\s+(.*))?$/i);
  if (skillsMatch) {
    const args = String(skillsMatch[1] || "").trim().split(/\s+/).filter(Boolean);
    const action = String(args[0] || "list").toLowerCase();
    if (action === "list" || action === "ls") {
      const outcome = listUcodeSkills({ workspaceRoot });
      return {
        kind: "skills",
        output: formatSkillsList(outcome),
        skills: outcome.skills,
        errors: outcome.errors,
      };
    }
    if (action === "show") {
      const name = String(args[1] || "").trim();
      if (!name) {
        return {
          kind: "error",
          output: "usage: skills show <name>",
        };
      }
      const result = showSkill({ name, workspaceRoot });
      if (!result.ok) {
        return {
          kind: "error",
          output: result.error,
        };
      }
      return {
        kind: "skills",
        output: result.output,
        skill: result.skill,
      };
    }
    return {
      kind: "error",
      output: "usage: skills [list] | skills show <name>",
    };
  }
  if (text === "bg" || text === "/bg") {
    return {
      kind: "error",
      output: "usage: bg <task>",
    };
  }
  const bgMatch = text.match(/^(?:\/bg|bg)\s+(.+)$/i);
  if (bgMatch) {
    const task = String(bgMatch[1] || "").trim();
    if (!task) {
      return {
        kind: "error",
        output: "usage: bg <task>",
      };
    }
    return {
      kind: "nl_bg",
      task,
    };
  }
  const resumeMatch = text.match(/^(?:\/resume|resume)(?:\s+(.+))?$/i);
  if (resumeMatch) {
    const session = String(resumeMatch[1] || "").trim();
    if (!session) {
      return {
        kind: "error",
        output: "usage: /resume <session-id>",
      };
    }
    return {
      kind: "resume",
      sessionId: session,
    };
  }

  const match = text.match(/^(tool|run)\s+([a-zA-Z_-]+)\s*(.*)$/);
  if (!match) {
    return {
      kind: "nl",
      task: text,
    };
  }
  const tool = String(match[2] || "").trim().toLowerCase();
  if (String(match[1]).toLowerCase() === "run" && !TOOL_NAMES.includes(tool)) {
    // Natural language like "run the tests" is not a tool invocation.
    return {
      kind: "nl",
      task: text,
    };
  }
  const payload = String(match[3] || "").trim();
  let args = {};
  try {
    args = parseJson(payload);
  } catch (err) {
    return {
      kind: "error",
      output: JSON.stringify({ ok: false, error: err && err.message ? err.message : "invalid json" }),
    };
  }
  const result = runToolCall(
    { tool, args },
    { workspaceRoot, cwd: workspaceRoot }
  );
  return {
    kind: "tool",
    tool,
    args,
    result,
    output: JSON.stringify(result),
  };
}

async function runUcodeCoreAgent({
  stdin = process.stdin,
  stdout = process.stdout,
  workspaceRoot = process.cwd(),
  provider = "",
  model = "",
  appendSystemPrompt = "",
  systemPrompt = "",
  sessionId = "",
  timeoutMs = 0,
  jsonOutput = false,
  forceTui = false,
  disableTui = false,
} = {}) {
  // Lazy-required to avoid a circular require with ./agent (nl orchestration),
  // which re-exports this module.
  const {
    buildNlContext,
    formatNlResult,
    persistSessionState,
    resumeSessionState,
    resolveNlTaskTimeoutMs,
    resolveUcodeProviderModel,
    runNaturalLanguageTask,
    resumeAfterUserInteraction,
    submitUserInteractionAnswer,
  } = require("./agent");
  const resolvedWorkspaceRoot = resolveUfooProjectRoot(workspaceRoot);
  const resolvedUcode = resolveUcodeProviderModel({
    workspaceRoot: resolvedWorkspaceRoot,
    provider,
    model,
  });
  const state = {
    workspaceRoot: resolvedWorkspaceRoot,
    provider: resolvedUcode.provider,
    model: resolvedUcode.model,
    engine: "ufoo-core",
    context: buildNlContext({
      appendSystemPrompt,
      systemPrompt,
      workspaceRoot: resolvedWorkspaceRoot,
      model: resolvedUcode.model,
      provider: resolvedUcode.provider,
    }),
    nlMessages: [],
    sessionId: resolveSessionId(String(sessionId || "").trim()),
    timeoutMs: resolveNlTaskTimeoutMs(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : NaN),
    jsonOutput,
  };
  persistSessionState(state);

  if (shouldUseUcodeTui({
    stdin,
    stdout,
    jsonOutput,
    forceTui,
    disableTui: disableTui || process.env.UFOO_UCODE_NO_TUI === "1",
  })) {
    return runUcodeTui({
      stdin,
      stdout,
      runSingleCommand,
      runNaturalLanguageTask,
      runUbusCommand,
      formatNlResult,
      workspaceRoot,
  state,
  resumeSessionState,
  persistSessionState,
      autoBus: {
        enabled: shouldAutoConsumeBus(process.env.UFOO_SUBSCRIBER_ID || ""),
        getPendingCount: () => getPendingBusCount(state.workspaceRoot || workspaceRoot, process.env.UFOO_SUBSCRIBER_ID || ""),
        subscriberId: String(process.env.UFOO_SUBSCRIBER_ID || "").trim(),
      },
    });
  }

  printUcodeBanner(stdout, {
    model: state.model || "default",
    workspaceRoot: workspaceRoot,
    sessionId: state.sessionId,
    planMode: Boolean(state.executionState && state.executionState.planMode),
  });
  printPrompt(stdout);
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    historySize: 200,
  });
  return new Promise((resolve) => {
    let chain = Promise.resolve();
    let backgroundSeq = 0;
    const backgroundRuns = new Map();
    const subscriberId = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
    const autoBusEnabled = shouldAutoConsumeBus(subscriberId);
    let autoBusTimer = null;
    let autoBusQueued = false;
    let autoBusError = "";
    let closing = false;
    let taskInFlight = false;

    const runAutoBusOnce = async () => {
      if (!autoBusEnabled || closing) return;
      if (getPendingBusCount(state.workspaceRoot || workspaceRoot, subscriberId) <= 0) {
        autoBusError = "";
        return;
      }
      const ubusResult = await runUbusCommand(state, {
        workspaceRoot: state.workspaceRoot || workspaceRoot,
        subscriberId,
      });
      if (!ubusResult.ok) {
        const nextError = String(ubusResult.error || "ubus failed");
        if (nextError !== autoBusError) {
          autoBusError = nextError;
          stdout.write(`Error: ${nextError}\n`);
          printPrompt(stdout);
        }
        return;
      }
      autoBusError = "";
      if (ubusResult.handled > 0) {
        const persisted = persistSessionState(state);
        if (!persisted || persisted.ok === false) {
          stdout.write(`Warning: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}\n`);
          printPrompt(stdout);
        }
      }
    };

    const scheduleAutoBus = () => {
      if (!autoBusEnabled || closing || autoBusQueued) return;
      if (getPendingBusCount(state.workspaceRoot || workspaceRoot, subscriberId) <= 0) return;
      autoBusQueued = true;
      chain = chain
        .then(() => runAutoBusOnce())
        .catch(() => {})
        .finally(() => {
          autoBusQueued = false;
        });
    };

    if (autoBusEnabled) {
      autoBusTimer = setInterval(() => {
        scheduleAutoBus();
      }, 800);
      scheduleAutoBus();
    }

    const startBackgroundTask = (task = "") => {
      backgroundSeq += 1;
      const jobId = `bg-${Date.now().toString(36)}-${backgroundSeq.toString(36)}`;
      const bgState = {
        workspaceRoot: state.workspaceRoot,
        provider: state.provider,
        model: state.model,
        engine: state.engine,
        context: state.context,
        nlMessages: Array.isArray(state.nlMessages) ? state.nlMessages.slice() : [],
        sessionId: "",
        timeoutMs: state.timeoutMs,
        jsonOutput: false,
      };
      const run = runNaturalLanguageTask(task, bgState)
        .then((nlResult) => {
          const summary = String(formatNlResult(nlResult, false) || "").trim();
          const title = nlResult && nlResult.ok ? "done" : "failed";
          stdout.write(`[${jobId}] ${title}: ${summary || "no summary"}\n`);
          printPrompt(stdout);
        })
        .catch((err) => {
          stdout.write(`[${jobId}] failed: ${err && err.message ? err.message : "background task failed"}\n`);
          printPrompt(stdout);
        })
        .finally(() => {
          backgroundRuns.delete(jobId);
        });
      backgroundRuns.set(jobId, run);
      return jobId;
    };

    const handleLine = async (line) => {
      const runtimeWorkspace = String(state.workspaceRoot || workspaceRoot || process.cwd());
      const result = runSingleCommand(line, runtimeWorkspace);
      if (result.kind === "exit") {
        rl.close();
        return;
      }
      if (result.kind === "legacy_ufoo_marker") {
        return;
      }
      if (result.kind === "help" || result.kind === "tool" || result.kind === "skills" || result.kind === "error") {
        stdout.write(`${result.output}\n`);
      }
      if (result.kind === "status") {
        const usageSummary = summarizeSessionUsage({
          workspaceRoot: runtimeWorkspace,
          sessionId: state.sessionId,
        });
        stdout.write(`${formatSessionUsageStatus(usageSummary)}\n`);
        const { formatPlanModeStatus } = require("./context/planMode");
        if (state.executionState) {
          stdout.write(`${formatPlanModeStatus(state.executionState).split("\n").slice(0, 5).join("\n")}\n`);
        }
      }
      if (result.kind === "model") {
        const applied = applyUcodeModelCommand(state, result);
        stdout.write(`${applied.output}\n`);
        if (applied.ok && result.action === "set") {
          persistSessionState(state);
        }
      }
      if (result.kind === "plan") {
        const applied = applyUcodePlanCommand(state, result);
        stdout.write(`${applied.output}\n`);
        if (applied.ok) persistSessionState(state);
      }
      if (result.kind === "ubus") {
        const ubusResult = await runUbusCommand(state, {
          workspaceRoot: runtimeWorkspace,
          onMessageReceived: (msg) => {
            // Display the incoming message immediately
            const nickname = extractAgentNickname(msg.from) || msg.from;
            stdout.write(`${nickname}: ${msg.task}\n`);
          },
        });
        if (!ubusResult.ok) {
          stdout.write(`Error: ${ubusResult.error}\n`);
        } else {
          // Display replies for each message
          if (ubusResult.messageExchanges && ubusResult.messageExchanges.length > 0) {
            for (const exchange of ubusResult.messageExchanges) {
              const nickname = extractAgentNickname(exchange.from) || exchange.from;
              stdout.write(`@${nickname} ${exchange.reply}\n`);
            }
          } else {
            stdout.write(`${ubusResult.summary}\n`);
          }
          persistSessionState(state);
        }
      }
      if (result.kind === "resume") {
        const resumed = resumeSessionState(state, result.sessionId, state.workspaceRoot || resolvedWorkspaceRoot);
        if (!resumed.ok) {
          stdout.write(`Error: ${resumed.error}\n`);
        } else {
          stdout.write(`Resumed session ${resumed.sessionId} (${resumed.restoredMessages} messages).\n`);
        }
      }
      if (result.kind === "nl_bg") {
        const jobId = startBackgroundTask(result.task);
        stdout.write(`[${jobId}] started in background.\n`);
      }
      if (result.kind === "nl") {
        let streamBuffer = null;
        let streamedVisible = false;
        const escapeStripper = createEscapeTagStripper();
        if (!state.jsonOutput) {
          streamBuffer = new StreamBuffer(stdout.write.bind(stdout), {
            delay: 10,
            chunkSize: 4,
          });
        }

        taskInFlight = true;
        let nlResult;
        try {
          nlResult = await runNaturalLanguageTask(result.task, state, {
            onDelta: state.jsonOutput
              ? null
              : async (delta) => {
                const text = escapeStripper.write(String(delta || ""));
                const safeText = stripBlessedTags(stripLeakedEscapeTags(text));
                if (!safeText) return;
                if (/[^\s]/.test(safeText)) {
                  streamedVisible = true;
                }
                if (streamBuffer) {
                  await streamBuffer.write(safeText);
                } else {
                  stdout.write(safeText);
                }
              },
          });
        } finally {
          taskInFlight = false;
        }

        if (!state.jsonOutput) {
          const tail = escapeStripper.flush();
          const safeTail = stripBlessedTags(stripLeakedEscapeTags(tail));
          if (safeTail) {
            if (/[^\s]/.test(safeTail)) {
              streamedVisible = true;
            }
            if (streamBuffer) {
              await streamBuffer.write(safeTail);
            } else {
              stdout.write(safeTail);
            }
          }
        }

        // Ensure buffer is flushed
        if (streamBuffer) {
          await streamBuffer.finish();
        }

        const streamed = !state.jsonOutput && Boolean(nlResult && nlResult.streamed);
        if (streamed && streamedVisible && nlResult && nlResult.streamLastChar !== "\n") {
          stdout.write("\n");
        }
        const shouldSkipSummary = Boolean(streamed && nlResult && nlResult.ok && streamedVisible);
        if (!shouldSkipSummary) {
          const formatted = formatNlResult(nlResult, state.jsonOutput);
          const safeOutput = state.jsonOutput
            ? formatted
            : stripBlessedTags(stripLeakedEscapeTags(formatted));
          stdout.write(`${safeOutput}\n`);
        }
        const persisted = persistSessionState(state);
        if (!state.jsonOutput && (!persisted || persisted.ok === false)) {
          stdout.write(`Warning: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}\n`);
        }
      }
      printPrompt(stdout);
    };

    rl.on("line", (line) => {
      const trimmed = normalizeLine(line);

      // Pending approval/choice/chat takes priority over nudge / new NL.
      try {
        const { hasPendingUserInteraction } = require("./context/userInteraction");
        if (
          trimmed
          && state.executionState
          && hasPendingUserInteraction(state.executionState)
        ) {
          chain = chain.then(async () => {
            let streamBuffer = null;
            let streamedVisible = false;
            const escapeStripper = createEscapeTagStripper();
            if (!state.jsonOutput) {
              streamBuffer = new StreamBuffer(stdout.write.bind(stdout), {
                delay: 10,
                chunkSize: 4,
              });
            }
            taskInFlight = true;
            let resumeResult;
            try {
              resumeResult = await submitUserInteractionAnswer(trimmed, state, {
                onDelta: state.jsonOutput
                  ? null
                  : async (delta) => {
                    const text = escapeStripper.write(String(delta || ""));
                    const safeText = stripBlessedTags(stripLeakedEscapeTags(text));
                    if (!safeText) return;
                    if (/[^\s]/.test(safeText)) {
                      streamedVisible = true;
                    }
                    if (streamBuffer) {
                      await streamBuffer.write(safeText);
                    } else {
                      stdout.write(safeText);
                    }
                  },
              });
            } finally {
              taskInFlight = false;
            }
            if (streamBuffer) {
              await streamBuffer.finish();
            }
            const streamed = !state.jsonOutput && Boolean(resumeResult && resumeResult.streamed);
            if (streamed && streamedVisible && resumeResult && resumeResult.streamLastChar !== "\n") {
              stdout.write("\n");
            }
            if (!resumeResult || resumeResult.ok === false) {
              stdout.write(`Error: ${(resumeResult && resumeResult.error) || "resume failed"}\n`);
            } else if (resumeResult.shouldEchoSummary && resumeResult.echoSummaryText) {
              stdout.write(`${resumeResult.echoSummaryText}\n`);
            } else if (resumeResult.waitingUserInteraction) {
              stdout.write("Still waiting for your reply.\n");
            }
            const persisted = persistSessionState(state);
            if (!state.jsonOutput && (!persisted || persisted.ok === false)) {
              stdout.write(`Warning: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}\n`);
            }
            printPrompt(stdout);
          }).catch((err) => {
            stdout.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : "resume failed" })}\n`);
            printPrompt(stdout);
          });
          return;
        }
      } catch (err) {
        stdout.write(`Error: ${err && err.message ? err.message : "interaction failed"}\n`);
        printPrompt(stdout);
        return;
      }

      // Mid-task NL input becomes a pending user reminder for the next LLM turn.
      if (taskInFlight && trimmed && !/^\//.test(trimmed)) {
        const { enqueueUserPrompt } = require("./context/userNudge");
        const { emptyExecutionState } = require("./context/executionSegment");
        if (!state.executionState || typeof state.executionState !== "object") {
          state.executionState = emptyExecutionState();
        }
        enqueueUserPrompt(state.executionState, trimmed);
        stdout.write("Queued user reminder for next model turn.\n");
        printPrompt(stdout);
        return;
      }
      chain = chain.then(() => handleLine(line)).catch((err) => {
        stdout.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : "agent loop failed" })}\n`);
        printPrompt(stdout);
      });
    });

    rl.on("close", () => {
      closing = true;
      if (autoBusTimer) {
        clearInterval(autoBusTimer);
        autoBusTimer = null;
      }
      chain.finally(() => resolve({ code: 0 }));
    });
  });
}

function parseAgentArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    workspaceRoot: "",
    provider: "",
    model: "",
    appendSystemPrompt: "",
    systemPrompt: "",
    sessionId: "",
    timeoutMs: 0,
    jsonOutput: false,
    forceTui: false,
    disableTui: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || "").trim();
    if (!item) continue;
    if (item === "--workspace" || item === "--cwd") {
      out.workspaceRoot = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--provider") {
      out.provider = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--model") {
      out.model = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--append-system-prompt") {
      out.appendSystemPrompt = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--system-prompt") {
      out.systemPrompt = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--session-id") {
      out.sessionId = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--timeout-ms") {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed)) out.timeoutMs = Math.max(1000, Math.floor(parsed));
      i += 1;
      continue;
    }
    if (item === "--json") {
      out.jsonOutput = true;
      continue;
    }
    if (item === "--tui") {
      out.forceTui = true;
      continue;
    }
    if (item === "--no-tui") {
      out.disableTui = true;
      continue;
    }
  }
  return out;
}

module.exports = {
  runUcodeCoreAgent,
  runSingleCommand,
  extractAgentNickname,
  parseAgentArgs,
  formatSessionUsageStatus,
  applyUcodeModelCommand,
  applyUcodePlanCommand,
  suggestUcodeModels,
};
