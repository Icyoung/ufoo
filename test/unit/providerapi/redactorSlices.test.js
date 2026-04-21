"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  redactSecrets,
  redactUfooEvent,
  redactToolCallPayload,
  REDACTED,
} = require("../../../src/providerapi/redactor");

describe("§10.7 redactor three-slice enforcement", () => {
  describe("slice 1 — tool pre-call envelope", () => {
    test("redactToolCallPayload scrubs secrets from args before handler executes", () => {
      const payload = redactToolCallPayload({
        name: "dispatch_message",
        args: {
          target: "agent:b",
          headers: { Authorization: "Bearer leaked-token" },
          accessToken: "also-leaked",
        },
        tool_call_id: "call-1",
        caller_tier: "worker",
      });

      expect(payload.name).toBe("dispatch_message");
      expect(payload.tool_call_id).toBe("call-1");
      expect(payload.caller_tier).toBe("worker");
      expect(payload.args.headers.Authorization).toBe(REDACTED);
      expect(payload.args.accessToken).toBe(REDACTED);
      expect(payload.args.target).toBe("agent:b");
    });
  });

  describe("slice 2 — provider post-stream event redaction", () => {
    test("redactUfooEvent scrubs bearer payloads on text_delta events", () => {
      expect(redactUfooEvent({
        type: "text_delta",
        delta: "please call with Authorization: Bearer abc123",
        itemType: "text",
      })).toEqual({
        type: "text_delta",
        delta: "please call with Authorization: Bearer [REDACTED]",
        itemType: "text",
      });
    });

    test("redactUfooEvent scrubs sensitive keys inside tool_call args", () => {
      expect(redactUfooEvent({
        type: "tool_call",
        toolCallId: "call-x",
        name: "route_agent",
        args: {
          refresh_token: "r-secret",
          headers: { Authorization: "Bearer y" },
          target: "reviewer",
        },
      })).toEqual({
        type: "tool_call",
        toolCallId: "call-x",
        name: "route_agent",
        args: {
          refresh_token: REDACTED,
          headers: { Authorization: REDACTED },
          target: "reviewer",
        },
      });
    });

    test("redactUfooEvent scrubs tool_result output payloads", () => {
      expect(redactUfooEvent({
        type: "tool_result",
        toolCallId: "call-y",
        output: { ok: true, access_token: "leak" },
      })).toEqual({
        type: "tool_result",
        toolCallId: "call-y",
        output: { ok: true, access_token: REDACTED },
      });
    });
  });

  describe("slice 3 — persistence pre-write (bus / history / report / observability)", () => {
    test("bus writers redact token payloads before disk write", () => {
      const { writeJSON, appendJSONL } = require("../../../src/bus/utils");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-bus-redact-"));
      const jsonFile = path.join(tmp, "state.json");
      const jsonlFile = path.join(tmp, "events.jsonl");
      try {
        writeJSON(jsonFile, {
          subscriber: "agent:a",
          headers: { Authorization: "Bearer leak" },
          apiKey: "also-leak",
        });
        appendJSONL(jsonlFile, {
          event: "bus.send",
          payload: "contains Authorization: Bearer super-secret token",
          access_token: "literal-secret",
        });

        const jsonRead = fs.readFileSync(jsonFile, "utf8");
        const jsonlRead = fs.readFileSync(jsonlFile, "utf8");
        expect(jsonRead).not.toMatch(/Bearer leak/);
        expect(jsonRead).not.toMatch(/also-leak/);
        expect(jsonlRead).not.toMatch(/super-secret/);
        expect(jsonlRead).not.toMatch(/literal-secret/);
        expect(jsonlRead).toMatch(/Bearer \[REDACTED\]/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("loop observability event file redacts bearer tokens", () => {
      const {
        createLoopObserver,
        appendShadowDiff,
      } = require("../../../src/agent/loopObservability");
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-obs-redact-"));
      try {
        const observer = createLoopObserver({ projectRoot });
        observer.emit("test.event", {
          payload: "Authorization: Bearer abc.def",
          token: "leak-1",
        });
        appendShadowDiff(projectRoot, {
          note: "Authorization: Bearer abc.def",
          refreshToken: "leak-2",
        });

        const eventsRead = fs.readFileSync(observer.paths.eventsFile, "utf8");
        expect(eventsRead).not.toMatch(/abc\.def/);
        expect(eventsRead).not.toMatch(/leak-1/);
        expect(eventsRead).toMatch(/Bearer \[REDACTED\]/);

        const diffDir = path.join(projectRoot, ".ufoo", "shadow");
        const diffFiles = fs.readdirSync(diffDir);
        expect(diffFiles.length).toBeGreaterThan(0);
        const diffRead = fs.readFileSync(path.join(diffDir, diffFiles[0]), "utf8");
        expect(diffRead).not.toMatch(/abc\.def/);
        expect(diffRead).not.toMatch(/leak-2/);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("report store redacts token payloads in both report file and state file", () => {
      const store = require("../../../src/report/store");
      const { getUfooPaths } = require("../../../src/ufoo/paths");
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-report-redact-"));
      try {
        fs.mkdirSync(getUfooPaths(projectRoot).agentDir, { recursive: true });
        store.appendReport(projectRoot, {
          from: "worker",
          kind: "secret-leak",
          text: "Authorization: Bearer secret-report",
          payload: { accessToken: "inner-leak" },
        });

        const paths = store.getReportPaths(projectRoot);
        const reportsRead = fs.readFileSync(paths.reportsFile, "utf8");
        expect(reportsRead).not.toMatch(/secret-report/);
        expect(reportsRead).not.toMatch(/inner-leak/);
        expect(reportsRead).toMatch(/Bearer \[REDACTED\]/);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });

  describe("redactSecrets defense against nested leaks", () => {
    test("deep arrays of tool_call events all get redacted", () => {
      const events = [
        { type: "text_delta", delta: "Authorization: Bearer hide-me" },
        { type: "tool_call", args: { apiKey: "also-hide" } },
      ];
      expect(redactSecrets(events)).toEqual([
        { type: "text_delta", delta: "Authorization: Bearer [REDACTED]" },
        { type: "tool_call", args: { apiKey: REDACTED } },
      ]);
    });
  });
});
