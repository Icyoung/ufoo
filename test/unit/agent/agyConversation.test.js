"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  RESUME_LINE_RE,
  extractResumeConversationId,
  readPreviousConversationId,
  persistConversationId,
  buildAgyLaunchArgs,
} = require("../../../src/agents/launch/agyConversation");

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agy-conv-"));
  fs.mkdirSync(path.join(dir, ".ufoo", "agent"), { recursive: true });
  return dir;
}

function agentsFilePath(projectRoot) {
  return path.join(projectRoot, ".ufoo", "agent", "all-agents.json");
}

function writeAgents(projectRoot, data) {
  fs.writeFileSync(agentsFilePath(projectRoot), JSON.stringify(data, null, 2));
}

describe("agyConversation.extractResumeConversationId", () => {
  test("extracts UUID from the Resume: agy --conversation=<uuid> line", () => {
    const sample = [
      "some prior output",
      "Resume: agy --conversation=9aeccc4f-cf41-42da-b4de-5203f63be95d (or -c)",
      "trailing line",
    ].join("\n");
    expect(extractResumeConversationId(sample)).toBe("9aeccc4f-cf41-42da-b4de-5203f63be95d");
  });

  test("handles output with trailing CR or extra whitespace", () => {
    const sample = "noise\r\nResume: agy  --conversation=AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE   \r\n";
    expect(extractResumeConversationId(sample)).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  });

  test("returns empty string when no Resume line is present", () => {
    expect(extractResumeConversationId("hello world")).toBe("");
    expect(extractResumeConversationId("")).toBe("");
    expect(extractResumeConversationId(null)).toBe("");
  });

  test("rejects malformed UUIDs", () => {
    const bad = "Resume: agy --conversation=not-a-uuid (or -c)";
    expect(extractResumeConversationId(bad)).toBe("");
  });

  test("RESUME_LINE_RE is anchored to the canonical phrase", () => {
    expect(RESUME_LINE_RE.test("Resume: agy --conversation=12345678-1234-1234-1234-123456789012")).toBe(true);
    expect(RESUME_LINE_RE.test("Random: agy --conversation=12345678-1234-1234-1234-123456789012")).toBe(false);
  });
});

describe("agyConversation.buildAgyLaunchArgs", () => {
  test("prepends --conversation when a previous id is supplied", () => {
    const out = buildAgyLaunchArgs({
      userArgs: [],
      previousConversationId: "9aeccc4f-cf41-42da-b4de-5203f63be95d",
    });
    expect(out).toEqual(["--conversation=9aeccc4f-cf41-42da-b4de-5203f63be95d"]);
  });

  test("does not override an explicit --continue / -c / --conversation passed by the user", () => {
    const previousId = "9aeccc4f-cf41-42da-b4de-5203f63be95d";

    expect(buildAgyLaunchArgs({ userArgs: ["-c"], previousConversationId: previousId }))
      .toEqual(["-c"]);
    expect(buildAgyLaunchArgs({ userArgs: ["--continue"], previousConversationId: previousId }))
      .toEqual(["--continue"]);
    expect(buildAgyLaunchArgs({ userArgs: ["--conversation=other"], previousConversationId: previousId }))
      .toEqual(["--conversation=other"]);
  });

  test("adds --dangerously-skip-permissions when skipPermissions is true and user didn't supply it", () => {
    const out = buildAgyLaunchArgs({
      userArgs: ["--sandbox"],
      skipPermissions: true,
    });
    expect(out).toEqual(["--dangerously-skip-permissions", "--sandbox"]);
  });

  test("does not duplicate --dangerously-skip-permissions when user already supplied it", () => {
    const out = buildAgyLaunchArgs({
      userArgs: ["--dangerously-skip-permissions"],
      skipPermissions: true,
    });
    expect(out).toEqual(["--dangerously-skip-permissions"]);
  });

  test("returns an empty array for no args / no resume / no skip flags", () => {
    expect(buildAgyLaunchArgs({})).toEqual([]);
  });
});

describe("agyConversation.readPreviousConversationId / persistConversationId", () => {
  test("reads provider_session_id keyed on tty match for agy subscribers only", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, {
        agents: {
          "codex:1234": { tty: "/dev/ttys001", provider_session_id: "codex-session" },
          "agy:abcd": { tty: "/dev/ttys001", provider_session_id: "9aeccc4f-cf41-42da-b4de-5203f63be95d" },
          "agy:other": { tty: "/dev/ttys002", provider_session_id: "should-not-match" },
        },
      });
      const found = readPreviousConversationId(projectRoot, { tty: "/dev/ttys001" });
      expect(found).toBe("9aeccc4f-cf41-42da-b4de-5203f63be95d");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("returns empty when tmuxPane is supplied but does not match", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, {
        agents: { "agy:abcd": { tmux_pane: "%1", provider_session_id: "uuid-1" } },
      });
      expect(readPreviousConversationId(projectRoot, { tmuxPane: "%2" })).toBe("");
      expect(readPreviousConversationId(projectRoot, { tmuxPane: "%1" })).toBe("uuid-1");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("returns empty when neither tty nor tmuxPane is provided", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, { agents: { "agy:abcd": { tty: "/dev/ttys001", provider_session_id: "x" } } });
      expect(readPreviousConversationId(projectRoot, {})).toBe("");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("persistConversationId updates provider_session_id atomically", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, { agents: { "agy:abcd": { tty: "/dev/ttys001" } } });
      const ok = persistConversationId(projectRoot, "agy:abcd", "11111111-2222-3333-4444-555555555555");
      expect(ok).toBe(true);
      const after = JSON.parse(fs.readFileSync(agentsFilePath(projectRoot), "utf8"));
      expect(after.agents["agy:abcd"].provider_session_id).toBe("11111111-2222-3333-4444-555555555555");
      expect(typeof after.agents["agy:abcd"].provider_session_updated_at).toBe("string");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("persistConversationId returns false when the subscriber is missing", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, { agents: {} });
      expect(persistConversationId(projectRoot, "agy:abcd", "uuid")).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("picks the most recently updated record when multiple match the same tty", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, {
        agents: {
          // Out-of-order on purpose — insertion order would pick the wrong one.
          "agy:older": {
            tty: "/dev/ttys001",
            provider_session_id: "uuid-old",
            provider_session_updated_at: "2026-01-01T00:00:00.000Z",
          },
          "agy:newer": {
            tty: "/dev/ttys001",
            provider_session_id: "uuid-new",
            provider_session_updated_at: "2026-05-22T12:00:00.000Z",
          },
          "agy:oldest": {
            tty: "/dev/ttys001",
            provider_session_id: "uuid-oldest",
            provider_session_updated_at: "2025-12-01T00:00:00.000Z",
          },
        },
      });
      expect(readPreviousConversationId(projectRoot, { tty: "/dev/ttys001" })).toBe("uuid-new");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("skips records whose owning pid is still alive (don't steal an active session)", () => {
    const projectRoot = mkProject();
    try {
      writeAgents(projectRoot, {
        agents: {
          "agy:alive": {
            tty: "/dev/ttys001",
            pid: process.pid, // current process is definitely alive
            provider_session_id: "uuid-active",
            provider_session_updated_at: "2026-05-22T13:00:00.000Z",
          },
          "agy:dead": {
            tty: "/dev/ttys001",
            // A pid that is almost certainly not in use. isAgentPidAlive
            // returns false for pids that can't be signaled.
            pid: 999999,
            provider_session_id: "uuid-orphaned",
            provider_session_updated_at: "2026-05-22T12:00:00.000Z",
          },
        },
      });
      expect(readPreviousConversationId(projectRoot, { tty: "/dev/ttys001" })).toBe("uuid-orphaned");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
