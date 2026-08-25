"use strict";

/**
 * Shared ucode slash-command dispatcher for Rust TUI hosts.
 * (NL foreground streaming stays host-specific.)
 */

const { applyUcodeModelCommand } = require("./modelCommand");
const { applyUcodePlanCommand, formatPlanModeStatus } = require("./context/planMode");
const { summarizeSessionUsage, formatSessionUsageStatus } = require("./usageStore");
const fmt = require("../ui/format");

/**
 * @param {object} result - parse result from runSingleCommand
 * @param {object} ports
 * @param {object} ports.state
 * @param {string} ports.workspaceRoot
 * @param {(text: string, kind?: string) => void} ports.appendLog
 * @param {() => void} [ports.persist]
 * @param {() => void} [ports.publishPlan]
 * @param {(meter: object) => void} [ports.publishUsage]
 * @param {() => void} [ports.onExit]
 * @param {(sessionId: string) => object} [ports.resumeSession]
 * @param {(entries: object[], notice: string) => void} [ports.replaceTranscript]
 * @param {(tool: string, args: object, payload: object) => void} [ports.onTool]
 * @param {(task: string) => Promise<void>|void} [ports.onBackground]
 * @param {(task: string) => Promise<object>|void} [ports.onNaturalLanguage]
 * @param {(state: object, opts: object) => Promise<object>} [ports.runUbus]
 * @param {(msg: string) => void} [ports.setBusyStatus]
 * @param {() => void} [ports.clearBusyStatus]
 * @param {(action: string) => Promise<object>|object} [ports.onQueueCommand]
 * @param {string[]} [ports.bannerLines]
 * @returns {Promise<{ handled: boolean, waiting?: boolean }>}
 */
async function dispatchUcodeSlashCommand(result, ports = {}) {
  if (!result || typeof result !== "object") {
    return { handled: false };
  }

  const appendLog = typeof ports.appendLog === "function" ? ports.appendLog : () => {};
  const persist = typeof ports.persist === "function" ? ports.persist : () => {};
  const publishPlan = typeof ports.publishPlan === "function" ? ports.publishPlan : () => {};
  const workspaceRoot = String(
    ports.workspaceRoot
    || (ports.state && ports.state.workspaceRoot)
    || process.cwd()
  );
  const state = ports.state || {};

  switch (result.kind) {
    case "empty":
    case "probe":
      return { handled: true };

    case "exit":
      if (typeof ports.onExit === "function") ports.onExit();
      return { handled: true, exit: true };

    case "help":
    case "error":
    case "skills":
    case "legacy_ufoo_marker":
      if (result.output) {
        appendLog(result.output, result.kind === "error" ? "error" : "system");
      }
      if (result.error) {
        appendLog(`Error: ${result.error}`, "error");
      }
      return { handled: true };

    case "status": {
      try {
        const usageSummary = summarizeSessionUsage({
          workspaceRoot,
          sessionId: state.sessionId || "",
        });
        appendLog(formatSessionUsageStatus(usageSummary), "system");
        if (state.executionState) {
          const planLines = formatPlanModeStatus(state.executionState)
            .split("\n")
            .slice(0, 6)
            .join("\n");
          if (planLines.trim()) appendLog(planLines, "system");
        }
      } catch (err) {
        appendLog(`Error: ${err && err.message ? err.message : "status failed"}`, "error");
      }
      return { handled: true };
    }

    case "queue": {
      if (typeof ports.onQueueCommand !== "function") {
        appendLog("Error: queue control unavailable", "error");
        return { handled: true };
      }
      const outcome = await ports.onQueueCommand(result.action || "status");
      if (outcome && outcome.output) {
        appendLog(outcome.output, outcome.ok === false ? "error" : "system");
      }
      return { handled: true, queue: outcome || null };
    }

    case "model": {
      const applied = await applyUcodeModelCommand(state, result, { workspaceRoot });
      appendLog(applied.output || "", applied.ok ? "system" : "error");
      if (applied.ok && result.action === "set") {
        try {
          const { buildContextMeter } = require("./contextWindow");
          const prev = state.contextMeter || {};
          const nextMeter = buildContextMeter({
            usedTokens: prev.usedTokens || 0,
            model: state.model || "",
          });
          state.contextMeter = nextMeter;
          if (typeof ports.publishUsage === "function") ports.publishUsage(nextMeter);
        } catch {
          // ignore
        }
        persist();
      }
      return { handled: true };
    }

    case "plan": {
      const applied = applyUcodePlanCommand(state, result);
      appendLog(applied.output || "", applied.ok ? "system" : "error");
      if (applied.refreshPlanUi || applied.ok) publishPlan();
      if (applied.ok) persist();
      return { handled: true };
    }

    case "ubus": {
      if (typeof ports.runUbus !== "function") {
        appendLog("Error: ubus unavailable", "error");
        return { handled: true };
      }
      if (typeof ports.setBusyStatus === "function") {
        ports.setBusyStatus("Checking bus messages...");
      }
      try {
        const { extractAgentNickname } = require("./agent");
        const ubusResult = await ports.runUbus(state, {
          workspaceRoot,
          onMessageReceived: (msg) => {
            const nickname = extractAgentNickname(msg && msg.from) || (msg && msg.from) || "bus";
            appendLog(`${nickname}: ${(msg && msg.task) || ""}`, "bus");
          },
        });
        if (!ubusResult || !ubusResult.ok) {
          appendLog(`Error: ${(ubusResult && ubusResult.error) || "ubus failed"}`, "error");
          return { handled: true };
        }
        const exchanges = Array.isArray(ubusResult.messageExchanges)
          ? ubusResult.messageExchanges
          : [];
        if (exchanges.length > 0) {
          for (const exchange of exchanges) {
            const nickname = extractAgentNickname(exchange && exchange.from)
              || (exchange && exchange.from)
              || "bus";
            appendLog(`@${nickname} ${(exchange && exchange.reply) || ""}`, "bus");
          }
        } else if (Number(ubusResult.handled) === 0) {
          appendLog("ubus: no pending messages.", "system");
        }
        persist();
      } finally {
        if (typeof ports.clearBusyStatus === "function") ports.clearBusyStatus();
      }
      return { handled: true };
    }

    case "resume": {
      if (typeof ports.resumeSession !== "function") {
        appendLog("Error: resume unsupported", "error");
        return { handled: true };
      }
      const resumed = ports.resumeSession(result.sessionId);
      if (!resumed || !resumed.ok) {
        appendLog(`Error: ${(resumed && resumed.error) || "resume failed"}`, "error");
        return { handled: true };
      }
      const markdownState = { inCodeBlock: false };
      const history = fmt.buildUcodeSessionLogEntries(
        Array.isArray(state.nlMessages) ? state.nlMessages : [],
        { markdownState, idPrefix: "h", startSeq: 0 },
      );
      const banner = Array.isArray(ports.bannerLines) ? ports.bannerLines : [];
      const bannerEntries = banner.concat([""]).map((line, idx) => ({
        id: `b-${idx}`,
        kind: idx < banner.length ? "banner" : "spacer",
        text: String(line || ""),
        speaker: "",
      }));
      const notice = {
        id: `h-resume-${Date.now().toString(36)}`,
        kind: "system",
        text: `Resumed session ${resumed.sessionId} (${resumed.restoredMessages} messages).`,
        speaker: "",
      };
      const entries = bannerEntries.concat(history.entries || []).concat([notice]);
      if (typeof ports.replaceTranscript === "function") {
        ports.replaceTranscript(entries, notice.text);
      } else {
        for (const entry of entries) {
          appendLog(entry.text, entry.kind || "system");
        }
      }
      if (state.contextMeter && typeof ports.publishUsage === "function") {
        ports.publishUsage(state.contextMeter);
      }
      publishPlan();
      return { handled: true };
    }

    case "tool": {
      if (typeof ports.onTool === "function") {
        const payload = result.result && typeof result.result === "object" ? result.result : {};
        ports.onTool(result.tool, result.args || {}, payload);
      } else if (result.output) {
        appendLog(result.output, "system");
      }
      return { handled: true };
    }

    case "nl_bg": {
      if (typeof ports.onBackground === "function") {
        await ports.onBackground(result.task);
      } else {
        appendLog("Error: background tasks unavailable", "error");
      }
      return { handled: true };
    }

    case "nl": {
      if (typeof ports.onNaturalLanguage === "function") {
        const nl = await ports.onNaturalLanguage(result.task);
        return { handled: true, waiting: Boolean(nl && nl.waiting) };
      }
      return { handled: false };
    }

    default:
      if (result.output) {
        appendLog(result.output, result.ok === false ? "error" : "system");
        return { handled: true };
      }
      return { handled: false };
  }
}

module.exports = {
  dispatchUcodeSlashCommand,
};
