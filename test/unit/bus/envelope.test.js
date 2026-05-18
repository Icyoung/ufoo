"use strict";

const {
  parseTagsFromOptions,
  formatTagList,
  renderHeader,
  renderEnvelope,
  validateTags,
  validateTaskId,
  normalizeTagList,
  sortTagsForRender,
  ACTION_TAGS,
  TASK_ID_MAX_LENGTH,
} = require("../../../src/bus/envelope");

describe("bus/envelope", () => {
  describe("normalizeTagList", () => {
    test("dedupes and lowercases", () => {
      expect(normalizeTagList(["Reply", "REPLY", "report"])).toEqual(["reply", "report"]);
    });

    test("accepts string with whitespace and commas", () => {
      expect(normalizeTagList("reply, report  fyi")).toEqual(["reply", "report", "fyi"]);
    });

    test("returns empty for null/undefined", () => {
      expect(normalizeTagList(null)).toEqual([]);
      expect(normalizeTagList(undefined)).toEqual([]);
    });
  });

  describe("validateTags", () => {
    test("accepts each known action tag", () => {
      for (const tag of ACTION_TAGS) {
        expect(() => validateTags([tag])).not.toThrow();
      }
    });

    test("rejects unknown tags", () => {
      expect(() => validateTags(["bogus"])).toThrow(/Unknown tag/);
    });

    test("rejects fyi alongside reply", () => {
      expect(() => validateTags(["fyi", "reply"])).toThrow(/mutually exclusive/);
    });

    test("rejects fyi alongside report", () => {
      expect(() => validateTags(["fyi", "report"])).toThrow(/mutually exclusive/);
    });

    test("allows reply + report together", () => {
      expect(() => validateTags(["reply", "report"])).not.toThrow();
    });
  });

  describe("validateTaskId", () => {
    test("returns empty when missing", () => {
      expect(validateTaskId("")).toBe("");
      expect(validateTaskId(null)).toBe("");
      expect(validateTaskId(undefined)).toBe("");
    });

    test("accepts allowed chars", () => {
      expect(validateTaskId("T-42")).toBe("T-42");
      expect(validateTaskId("task_99.1")).toBe("task_99.1");
    });

    test("rejects spaces", () => {
      expect(() => validateTaskId("T 42")).toThrow(/invalid characters/);
    });

    test("rejects bracket-breaking chars", () => {
      expect(() => validateTaskId("T]42")).toThrow(/invalid characters/);
      expect(() => validateTaskId("T[42")).toThrow(/invalid characters/);
    });

    test("rejects too-long ids", () => {
      const big = "x".repeat(TASK_ID_MAX_LENGTH + 1);
      expect(() => validateTaskId(big)).toThrow(/too long/);
    });
  });

  describe("sortTagsForRender", () => {
    test("renders reply, report, fyi in fixed order", () => {
      expect(sortTagsForRender(["fyi"])).toEqual(["fyi"]);
      expect(sortTagsForRender(["report", "reply"])).toEqual(["reply", "report"]);
    });
  });

  describe("parseTagsFromOptions", () => {
    test("collects flag-style options", () => {
      expect(parseTagsFromOptions({ reply: true, report: true, taskId: "T-1" })).toEqual({
        tags: ["reply", "report"],
        taskId: "T-1",
        reportTo: "",
      });
    });

    test("supports --task and --report-to aliases", () => {
      expect(parseTagsFromOptions({ report: true, task: "T-2", report_to: "ufoo-agent" })).toEqual({
        tags: ["report"],
        taskId: "T-2",
        reportTo: "ufoo-agent",
      });
    });

    test("rejects fyi + reply combination at parse time", () => {
      expect(() => parseTagsFromOptions({ fyi: true, reply: true })).toThrow(/mutually exclusive/);
    });

    test("rejects bad task_id at parse time", () => {
      expect(() => parseTagsFromOptions({ task: "bad id" })).toThrow(/invalid characters/);
    });

    test("supports tags as array option", () => {
      expect(parseTagsFromOptions({ tags: ["reply", "report"] })).toEqual({
        tags: ["reply", "report"],
        taskId: "",
        reportTo: "",
      });
    });
  });

  describe("formatTagList", () => {
    test("returns empty string for no tags / no task", () => {
      expect(formatTagList({})).toBe("");
    });

    test("renders task in fixed slot", () => {
      expect(formatTagList({ tags: ["report", "reply"], taskId: "T-1" })).toBe(
        "[reply] [report] [task:T-1]",
      );
    });

    test("renders fyi alone", () => {
      expect(formatTagList({ tags: ["fyi"] })).toBe("[fyi]");
    });
  });

  describe("renderHeader", () => {
    test("bus header with id only", () => {
      expect(renderHeader({ kind: "bus", fromId: "claude-code:abc", fromNickname: "" })).toBe(
        "[ufoo]<from:claude-code:abc>",
      );
    });

    test("bus header with id and nickname", () => {
      expect(
        renderHeader({ kind: "bus", fromId: "claude-code:abc", fromNickname: "architect" }),
      ).toBe("[ufoo]<from:claude-code:abc(architect)>");
    });

    test("manual header with tags", () => {
      expect(
        renderHeader({
          kind: "manual",
          toId: "claude-code:xyz",
          toNickname: "dev",
          tags: ["reply"],
          taskId: "T-7",
        }),
      ).toBe("[manual]<to:claude-code:xyz(dev)> [reply] [task:T-7]");
    });

    test("falls back to unknown when no party", () => {
      expect(renderHeader({ kind: "bus" })).toBe("[ufoo]<from:unknown>");
    });

    test("uses nickname only when id matches nickname", () => {
      expect(renderHeader({ kind: "bus", fromId: "ufoo-agent", fromNickname: "ufoo-agent" })).toBe(
        "[ufoo]<from:ufoo-agent>",
      );
    });
  });

  describe("renderEnvelope", () => {
    test("renders header + body", () => {
      expect(
        renderEnvelope({
          kind: "bus",
          fromId: "claude-code:abc",
          fromNickname: "architect",
          tags: ["reply"],
          taskId: "T-1",
          message: "review src/main.ts",
        }),
      ).toBe("[ufoo]<from:claude-code:abc(architect)> [reply] [task:T-1]\nreview src/main.ts");
    });

    test("renders header only when no message", () => {
      expect(renderEnvelope({ kind: "bus", fromId: "x", fromNickname: "y" })).toBe(
        "[ufoo]<from:x(y)>",
      );
    });

    test("preserves multi-line message body", () => {
      const out = renderEnvelope({
        kind: "bus",
        fromId: "x",
        message: "line1\nline2\nline3",
      });
      expect(out).toBe("[ufoo]<from:x>\nline1\nline2\nline3");
    });
  });
});
