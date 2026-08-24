const { ACTIVITY_STATES, ActivityDetector } = require("../../../src/agents/activity/activityDetector");

function createDetector(agentType = "claude-code", options = {}) {
  return new ActivityDetector(agentType, {
    quietWindowMs: 50,
    ...options,
  });
}

describe("ActivityDetector", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("ACTIVITY_STATES", () => {
    test("exports all expected states", () => {
      expect(ACTIVITY_STATES).toEqual({
        starting: "starting",
        ready: "ready",
        working: "working",
        idle: "idle",
        waiting_input: "waiting_input",
        blocked: "blocked",
      });
    });
  });

  describe("initial state", () => {
    test("starts in STARTING", () => {
      const detector = createDetector();
      expect(detector.getState().state).toBe("starting");
    });
  });

  describe("ready/working transitions", () => {
    test("transitions STARTING -> READY via markReady", () => {
      const detector = createDetector();
      detector.markReady();
      expect(detector.getState().state).toBe("ready");
    });

    test("ignores markReady from non-STARTING states", () => {
      const detector = createDetector();
      detector.markReady();
      detector.markWorking();
      detector.markReady();
      expect(detector.getState().state).toBe("working");
    });

    test("processOutput while STARTING is ignored", () => {
      jest.useFakeTimers();
      const detector = createDetector();
      detector.processOutput("Allow  Deny");
      jest.advanceTimersByTime(100);
      expect(detector.getState().state).toBe("starting");
    });

    test("processOutput can transition STARTING -> WORKING when startOnOutput enabled", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code", { startOnOutput: true });
      detector.processOutput("some startup output");
      expect(detector.getState().state).toBe("working");
    });

    test("ignores whitespace-only output in STARTING even when startOnOutput enabled", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code", { startOnOutput: true });
      detector.processOutput("\r\n   \r\n");
      expect(detector.getState().state).toBe("starting");
    });

    test("any output after READY marks WORKING immediately", () => {
      const detector = createDetector();
      detector.markReady();
      detector.processOutput("some output");
      expect(detector.getState().state).toBe("working");
    });

    test("ignores focus redraw style output in READY", () => {
      jest.useFakeTimers();
      const detector = createDetector();
      detector.markReady();
      detector.processOutput("\u001b[?2026h\r\u001b[2C\u001b[3A\u001b[7m \u001b[27m\r\r\n\r\n\r\n\u001b[?2026l");
      expect(detector.getState().state).toBe("ready");
    });
  });

  describe("quiet-window classification", () => {
    test("transitions WORKING -> WAITING_INPUT after quiet window when prompt is present", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code");
      detector.markReady();
      detector.processOutput("Allow  Deny");
      expect(detector.getState().state).toBe("working");

      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("transitions WORKING -> IDLE after quiet window when no prompt is present", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code");
      detector.markReady();
      detector.processOutput("processing...\nno prompt here");
      expect(detector.getState().state).toBe("working");

      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("idle");
    });

    test("resets quiet timer on new output", () => {
      jest.useFakeTimers();
      const detector = createDetector("codex");
      detector.markReady();
      detector.processOutput("Continue?");
      jest.advanceTimersByTime(30);
      detector.processOutput(" y/n");

      jest.advanceTimersByTime(30);
      expect(detector.getState().state).toBe("working");

      jest.advanceTimersByTime(25);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("uses tail window across multiple chunks", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code");
      detector.markReady();
      detector.processOutput("Allow ");
      detector.processOutput("Deny");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("detects Ink TUI navigation bar as waiting_input (plan mode / AskUserQuestion)", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code");
      detector.markReady();
      detector.processOutput("Enter to select · ↑/↓ to navigate · Esc to cancel");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("agy: terminal command approval is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("agy");
      detector.markReady();
      detector.processOutput("Run the following command?\nYes, and run in sandbox\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("agy: menu selector is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("agy");
      detector.markReady();
      detector.processOutput("Select login method:\n[Use arrow keys to navigate, Enter to select]");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("agy: eligibility failure goes directly to BLOCKED (no waiting_input → timer)", () => {
      jest.useFakeTimers();
      const detector = createDetector("agy");
      detector.markReady();
      detector.processOutput("Eligibility Check\n");
      detector.processOutput("Eligibility check failed: Your current account is not eligible for Antigravity.\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("blocked");
      expect(detector.getState().detail).toContain("fatal");
    });

    test("agy: region restriction goes directly to BLOCKED", () => {
      jest.useFakeTimers();
      const detector = createDetector("agy");
      detector.markReady();
      detector.processOutput("FAILED_PRECONDITION: User location is not supported for the API use.");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("blocked");
    });

    test("grok: approval dialog is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput("The agent wants to run a shell command\nApprove plan    Reject plan\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("grok: plan approval status line is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput("plan.md\nWaiting on plan approval\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("grok: empty plan approval preview is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput([
        "# No plan written yet",
        "",
        "- **Approve** — leave plan mode and start implementing",
        "- **Request changes** — send the agent back to planning",
        "- **Quit** — abandon and turn plan mode off",
      ].join("\n"));
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("grok: permission overlay is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput([
        "Allow command?",
        "$ npm test",
        "1 (●) Allow once",
        "2 (○) Always allow: npm test",
        "3 (○) No, reject (type to add feedback)",
      ].join("\n"));
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("grok: ask_user_question freeform row is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput([
        "Which implementation should I use?",
        "1 (○) Minimal",
        "2 (○) Full provider",
        "z (○) Type your answer here",
      ].join("\n"));
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("grok: idle footer is idle, not waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput("grok-build\nEnter:run│Esc:reset│Tab:next example│Type:custom command\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("idle");
    });

    test("grok: welcome menu is idle and logo redraws do not reopen working", () => {
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput([
        "Grok Build 1.0.5",
        "New worktree",
        "Resume session",
        "Changelog",
        "Quit",
      ].join("\n"));

      expect(detector.getState().state).toBe("idle");

      detector.processOutput("\u001b[38;2;120;120;120m⠙\u001b[?2026l");
      detector.processOutput("20;20;20m⠀⠀⢀⠞⠁");
      expect(detector.getState().state).toBe("idle");
    });

    test("grok: markWorking clears the idle welcome-screen latch", () => {
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput([
        "Grok Build 1.0.5",
        "New worktree",
        "Resume session",
        "Changelog",
        "Quit",
      ].join("\n"));

      detector.markWorking();
      detector.processOutput("Thinking about the requested task...");
      expect(detector.getState().state).toBe("working");
    });

    test("grok: auth error goes directly to BLOCKED", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput("Run `grok login` first, or set XAI_API_KEY.\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("blocked");
      expect(detector.getState().detail).toContain("fatal");
    });

    test("grok: free usage paywall goes directly to BLOCKED", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput("You have reached your free Grok Build usage limit.\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("blocked");
      expect(detector.getState().detail).toContain("fatal");
    });

    test("grok: subscription gate goes directly to BLOCKED", () => {
      jest.useFakeTimers();
      const detector = createDetector("grok");
      detector.markReady();
      detector.processOutput("SuperGrok subscription required\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("blocked");
    });

    // Fixture trimmed from a real kimi 0.27.0 PTY capture of the bash
    // approval dialog (default permission mode, prompt "运行 ls 命令").
    const KIMI_APPROVAL_DIALOG = [
      "  ▶ Run this command?",
      "",
      "  cwd: /private/tmp/kimi-probe-cwd",
      "  $ ls",
      "",
      "  ▶ 1. Approve once",
      "    2. Approve for this session",
      "    3. Reject",
      "    4. Reject with feedback",
      "",
      "  ↑/↓ select · 1/2/3/4 choose · ↵ confirm",
    ].join("\n");

    test("kimi: bash approval dialog is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("kimi");
      detector.markReady();
      detector.processOutput(KIMI_APPROVAL_DIALOG);
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("kimi: approval question line alone is waiting_input", () => {
      jest.useFakeTimers();
      const detector = createDetector("kimi");
      detector.markReady();
      detector.processOutput("● Running a command\n  $ ls\n  ▶ Run this command?\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("kimi: thinking spinner without a prompt goes idle", () => {
      jest.useFakeTimers();
      const detector = createDetector("kimi");
      detector.markReady();
      detector.processOutput(" ⠙ thinking...\n ⠹ thinking...\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("idle");
    });
  });

  describe("markWorking behavior", () => {
    test("does not clear buffer when already WORKING", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code");
      detector.markReady();
      detector.markWorking();
      detector.processOutput("Allow ");
      detector.markWorking(); // launcher may call this on each output chunk
      detector.processOutput("Deny");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("resets WAITING_INPUT -> WORKING and clears blocked timer", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code", { blockedTimeoutMs: 100 });
      detector.markReady();
      detector.processOutput("Allow  Deny");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");

      detector.markWorking();
      expect(detector.getState().state).toBe("working");

      jest.advanceTimersByTime(120);
      expect(detector.getState().state).not.toBe("blocked");
    });
  });

  describe("blocked timeout", () => {
    test("transitions WAITING_INPUT -> BLOCKED after timeout", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code", { blockedTimeoutMs: 100 });
      detector.markReady();
      detector.processOutput("Allow  Deny");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");

      jest.advanceTimersByTime(101);
      expect(detector.getState().state).toBe("blocked");
    });

    test("markIdle recovers from BLOCKED", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code", { blockedTimeoutMs: 100 });
      detector.markReady();
      detector.processOutput("Allow  Deny");
      jest.advanceTimersByTime(160);
      expect(detector.getState().state).toBe("blocked");

      detector.markIdle();
      expect(detector.getState().state).toBe("idle");
    });
  });

  describe("false positive guards", () => {
    test("does not detect prompt-like text inside code fences", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code");
      detector.markReady();
      detector.processOutput("```\nif (Allow && Deny) {\n  return true;\n}\n```");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("idle");
    });

    test("does not detect prompt-like text in import/comment line", () => {
      jest.useFakeTimers();
      const detector = createDetector("codex");
      detector.markReady();
      detector.processOutput('import x from "y"; // [Y/n]');
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("idle");
    });

    test("still detects prompt when prior lines contain code", () => {
      jest.useFakeTimers();
      const detector = createDetector("codex");
      detector.markReady();
      detector.processOutput("import fs from 'fs';\nconst x = 1;\n");
      detector.processOutput("Continue?\n");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });
  });

  describe("normalization and configuration", () => {
    test("normalizes ANSI output before detection", () => {
      jest.useFakeTimers();
      const detector = createDetector("codex");
      detector.markReady();
      detector.processOutput("\u001b[31mContinue? [Y/n]\u001b[0m");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");
    });

    test("strips OSC title updates and ignores them as non-meaningful output", () => {
      const detector = createDetector("claude-code", { startOnOutput: true });
      detector.processOutput("\u001b]0;⠂ Claude Code\u0007");
      expect(detector.getState().state).toBe("starting");
    });

    test("uses mode-based quiet defaults", () => {
      const internal = new ActivityDetector("claude-code", { mode: "internal" });
      const terminal = new ActivityDetector("claude-code", { mode: "terminal" });
      const ptyRunner = new ActivityDetector("claude-code", { mode: "pty-runner" });
      expect(internal.quietWindowMs).toBe(3500);
      expect(terminal.quietWindowMs).toBe(5000);
      expect(ptyRunner.quietWindowMs).toBe(5000);
    });

    test("quietWindowMs option overrides mode default", () => {
      const detector = new ActivityDetector("claude-code", {
        mode: "terminal",
        quietWindowMs: 1234,
      });
      expect(detector.quietWindowMs).toBe(1234);
    });
  });

  describe("callbacks/getState/destroy", () => {
    test("onChange includes detail for WAITING_INPUT pattern", () => {
      jest.useFakeTimers();
      const changes = [];
      const detector = createDetector("claude-code");
      detector.onChange((next, prev, detail) => {
        changes.push({ next, prev, detail });
      });
      detector.markReady();
      detector.processOutput("Allow  Deny");
      jest.advanceTimersByTime(51);
      const waitingChange = changes.find((entry) => entry.next === "waiting_input");
      expect(waitingChange).toBeDefined();
      expect(waitingChange.detail).toBeTruthy();
    });

    test("getState returns state/since/detail", () => {
      const detector = createDetector();
      const snap = detector.getState();
      expect(snap).toHaveProperty("state", "starting");
      expect(snap).toHaveProperty("since");
      expect(snap).toHaveProperty("detail");
      expect(typeof snap.since).toBe("number");
    });

    test("destroy clears timers", () => {
      jest.useFakeTimers();
      const detector = createDetector("claude-code", { blockedTimeoutMs: 100 });
      detector.markReady();
      detector.processOutput("Allow  Deny");
      jest.advanceTimersByTime(51);
      expect(detector.getState().state).toBe("waiting_input");

      detector.destroy();
      jest.advanceTimersByTime(200);
      expect(detector.getState().state).toBe("waiting_input");
    });
  });
});
