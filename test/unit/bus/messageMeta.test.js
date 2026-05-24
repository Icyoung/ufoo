"use strict";

const {
  buildMessageData,
  getTagsFromEvent,
  getTaskIdFromEvent,
  getReportToFromEvent,
} = require("../../../src/coordination/bus/messageMeta");

describe("bus/messageMeta tags schema", () => {
  test("plain message has no tag fields", () => {
    const data = buildMessageData("hi");
    expect(data.message).toBe("hi");
    expect(data.tags).toBeUndefined();
    expect(data.task_id).toBeUndefined();
    expect(data.report_to).toBeUndefined();
  });

  test("flag-style options populate tags", () => {
    const data = buildMessageData("review", { reply: true, taskId: "T-42" });
    expect(data.tags).toEqual(["reply"]);
    expect(data.task_id).toBe("T-42");
  });

  test("reply + report co-occur", () => {
    const data = buildMessageData("x", { reply: true, report: true });
    expect(data.tags).toEqual(["reply", "report"]);
  });

  test("fyi rejects reply", () => {
    expect(() => buildMessageData("x", { fyi: true, reply: true })).toThrow(/mutually exclusive/);
  });

  test("invalid task_id rejects at build time", () => {
    expect(() => buildMessageData("x", { reply: true, task: "bad id" })).toThrow(/invalid characters/);
  });

  test("report_to falls into data when provided", () => {
    const data = buildMessageData("x", { report: true, reportTo: "ufoo-agent", task: "T-1" });
    expect(data.tags).toEqual(["report"]);
    expect(data.report_to).toBe("ufoo-agent");
    expect(data.task_id).toBe("T-1");
  });

  test("inline data tags are normalized and validated", () => {
    const data = buildMessageData("x", { data: { tags: ["Reply", "REPLY", "report"] } });
    expect(data.tags).toEqual(["reply", "report"]);
  });

  test("inline data with invalid task_id throws", () => {
    expect(() => buildMessageData("x", { data: { tags: ["reply"], task_id: "bad id" } })).toThrow(
      /invalid characters/,
    );
  });

  test("event readers parse tags", () => {
    const evt = { data: { tags: ["reply", "report"], task_id: "T-9", report_to: "ufoo-agent" } };
    expect(getTagsFromEvent(evt)).toEqual(["reply", "report"]);
    expect(getTaskIdFromEvent(evt)).toBe("T-9");
    expect(getReportToFromEvent(evt)).toBe("ufoo-agent");
  });

  test("event readers fall back gracefully on missing fields", () => {
    expect(getTagsFromEvent({})).toEqual([]);
    expect(getTaskIdFromEvent({})).toBe("");
    expect(getReportToFromEvent({})).toBe("");
  });

  test("event readers ignore malformed fields", () => {
    expect(getTagsFromEvent({ data: { tags: ["bogus"] } })).toEqual([]);
    expect(getTaskIdFromEvent({ data: { task_id: "bad id" } })).toBe("");
  });
});
