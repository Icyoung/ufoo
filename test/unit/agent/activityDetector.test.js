const { ACTIVITY_STATES, ActivityDetector } = require("../../../src/agent/activityDetector");

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
      const internal = new ActivityDetector("claude-code", { mode: "internal-pty" });
      const terminal = new ActivityDetector("claude-code", { mode: "terminal" });
      expect(internal.quietWindowMs).toBe(3500);
      expect(terminal.quietWindowMs).toBe(5000);
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
