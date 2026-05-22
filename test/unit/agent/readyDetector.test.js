const ReadyDetector = require("../../../src/agent/readyDetector");

describe("ReadyDetector", () => {
  describe("claude-code prompt detection", () => {
    test("should detect prompt marker ❯", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("some initial output\n");
      expect(readyCalled).toBe(false);

      detector.processOutput("❯ Try something\n");
      expect(readyCalled).toBe(true);
      expect(detector.ready).toBe(true);
    });

    test("should detect separator line", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      const bannerOutput = `
  ██╗   ██╗███████╗ ██████╗  ██████╗
  ██║   ██║██╔════╝██╔═══██╗██╔═══██╗

────────────────────────────────────────────────────────────────────────────────
❯ Try "fix typecheck errors"
`;

      detector.processOutput(bannerOutput);
      expect(readyCalled).toBe(true);
      expect(detector.ready).toBe(true);
    });

    test("should handle multi-line output gradually", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("Line 1\n");
      expect(readyCalled).toBe(false);

      detector.processOutput("Line 2\n");
      expect(readyCalled).toBe(false);

      detector.processOutput("────────────────\n");
      expect(readyCalled).toBe(false);

      detector.processOutput("❯ Try something\n");
      expect(readyCalled).toBe(true);
    });
  });

  describe("buffer management", () => {
    test("should limit buffer size to maxBufferSize", () => {
      const detector = new ReadyDetector("claude-code");
      detector.maxBufferSize = 100; // Small size for testing

      const longOutput = "x".repeat(200);
      detector.processOutput(longOutput);

      expect(detector.buffer.length).toBeLessThanOrEqual(100);
    });

    test("should keep recent data when buffer is full", () => {
      const detector = new ReadyDetector("claude-code");
      detector.maxBufferSize = 50;

      detector.processOutput("AAAAA".repeat(20)); // 100 chars
      detector.processOutput("BBBBB");

      // Should contain recent B's, not old A's
      expect(detector.buffer).toContain("BBBBB");
      expect(detector.buffer.length).toBeLessThanOrEqual(50);
    });
  });

  describe("onReady callback", () => {
    test("should call all registered callbacks", () => {
      const detector = new ReadyDetector("claude-code");
      const calls = [];

      detector.onReady(() => calls.push(1));
      detector.onReady(() => calls.push(2));
      detector.onReady(() => calls.push(3));

      detector.processOutput("❯");

      expect(calls).toEqual([1, 2, 3]);
    });

    test("should call callback immediately if already ready", () => {
      const detector = new ReadyDetector("claude-code");
      detector.processOutput("❯");

      let called = false;
      detector.onReady(() => {
        called = true;
      });

      expect(called).toBe(true);
    });

    test("should handle callback errors gracefully", () => {
      const detector = new ReadyDetector("claude-code");

      detector.onReady(() => {
        throw new Error("Callback error");
      });

      let secondCalled = false;
      detector.onReady(() => {
        secondCalled = true;
      });

      // Should not throw
      expect(() => detector.processOutput("❯")).not.toThrow();

      // Second callback should still be called
      expect(secondCalled).toBe(true);
    });
  });

  describe("forceReady", () => {
    test("should trigger ready state manually", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.forceReady();

      expect(readyCalled).toBe(true);
      expect(detector.ready).toBe(true);
    });

    test("should be idempotent", () => {
      const detector = new ReadyDetector("claude-code");
      let callCount = 0;
      detector.onReady(() => {
        callCount++;
      });

      detector.forceReady();
      detector.forceReady();
      detector.forceReady();

      expect(callCount).toBe(1);
    });
  });

  describe("codex detection", () => {
    test("should detect codex prompt", () => {
      const detector = new ReadyDetector("codex");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("codex> ");
      expect(readyCalled).toBe(true);
    });

    test("should detect generic > prompt", () => {
      const detector = new ReadyDetector("codex");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("Ready\n> ");
      expect(readyCalled).toBe(true);
    });
  });

  describe("ufoo-code detection", () => {
    test("should detect ucode prompt", () => {
      const detector = new ReadyDetector("ufoo-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("ucode> ");
      expect(readyCalled).toBe(true);
    });

    test("should detect pi-mono prompt", () => {
      const detector = new ReadyDetector("ufoo-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("pi-mono> ");
      expect(readyCalled).toBe(true);
    });

    test("should not detect false positive from inline > symbol", () => {
      const detector = new ReadyDetector("ufoo-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput("expression: a > b\n");
      expect(readyCalled).toBe(false);
    });
  });

  describe("agy detection", () => {
    test("triggers ready when the '? for shortcuts' status footer appears", () => {
      const detector = new ReadyDetector("agy");
      let readyCalled = false;
      detector.onReady(() => { readyCalled = true; });
      // Sample captured from real agy boot output (PTY screen capture):
      // a bordered input box, then the status line.
      detector.processOutput("│ > │\n? for shortcuts        Gemini 3.5 Flash (High)\n");
      expect(readyCalled).toBe(true);
    });

    test("does not fire ready while still on the OAuth signin spinner", () => {
      const detector = new ReadyDetector("agy");
      let readyCalled = false;
      detector.onReady(() => { readyCalled = true; });
      detector.processOutput("Welcome to the Antigravity CLI.\n");
      detector.processOutput("⣷ Signing in...\n");
      expect(readyCalled).toBe(false);
    });

    test("still fires ready when the account is ineligible (TUI still mounts)", () => {
      const detector = new ReadyDetector("agy");
      let readyCalled = false;
      detector.onReady(() => { readyCalled = true; });
      detector.processOutput("Eligibility Check\n");
      detector.processOutput("Eligibility check failed: Your current account is not eligible for Antigravity.\n");
      detector.processOutput("? for shortcuts        Gemini 3.5 Flash (High)\n");
      expect(readyCalled).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("should handle Buffer input", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      detector.processOutput(Buffer.from("❯ prompt"));
      expect(readyCalled).toBe(true);
    });

    test("should handle empty input", () => {
      const detector = new ReadyDetector("claude-code");

      expect(() => detector.processOutput("")).not.toThrow();
      expect(() => detector.processOutput(null)).not.toThrow();
      expect(() => detector.processOutput(undefined)).not.toThrow();
    });

    test("should not detect false positives", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      // These should NOT trigger ready
      detector.processOutput("Loading...");
      detector.processOutput("Initializing...");
      detector.processOutput("────"); // Too short

      expect(readyCalled).toBe(false);
    });

    test("should stop processing after ready", () => {
      const detector = new ReadyDetector("claude-code");
      let callCount = 0;
      detector.onReady(() => {
        callCount++;
      });

      detector.processOutput("❯");
      expect(callCount).toBe(1);

      // Further output should not trigger callbacks again
      detector.processOutput("❯");
      detector.processOutput("❯");

      expect(callCount).toBe(1);
    });
  });

  describe("real-world scenarios", () => {
    test("should handle typical claude-code startup output", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      // Simulate typical startup sequence
      detector.processOutput("\x1b[0m\x1b[36m");
      detector.processOutput("  ██╗   ██╗███████╗ ██████╗  ██████╗  \n");
      detector.processOutput("  ██║   ██║██╔════╝██╔═══██╗██╔═══██╗\n");
      detector.processOutput("\n");
      detector.processOutput("────────────────────────────────────────\n");
      detector.processOutput("❯ Try \"help\"\n");
      detector.processOutput("────────────────────────────────────────\n");

      expect(readyCalled).toBe(true);
    });

    test("should handle slow/chunked output", () => {
      const detector = new ReadyDetector("claude-code");
      let readyCalled = false;
      detector.onReady(() => {
        readyCalled = true;
      });

      // Simulate slow output, one char at a time
      "Loading claude-code... ❯".split("").forEach((char) => {
        detector.processOutput(char);
      });

      expect(readyCalled).toBe(true);
    });
  });
});
