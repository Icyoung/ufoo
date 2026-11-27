const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBackgroundTaskProgress } = require("../../../src/ui/backgroundTaskProgress");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

describe("background task progress", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "task-progress-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("replays recent activity, reads incremental updates and isolates parallel tasks on one worker", () => {
    const dir = getUfooPaths(root).busEventsDir;
    fs.mkdirSync(dir, { recursive: true });
    function emit(task_id, type, data) {
      const event = { event: "agent_surface", publisher: "worker", data: { surface: { task_id, type, ...data } } };
      fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
    }
    const tasks = ["one", "two"].map(id => ({ id, workerId: "worker", status: "queued", detail: id }));
    emit("one", "tool_call", { name: "write", args: { path: "rig.py" }, toolCallId: "call" });
    const read = createBackgroundTaskProgress();
    expect(read(root, tasks)).toMatchObject([
      { status: "running", progress: { title: "Write rig.py", status: "running" } },
      { status: "queued", detail: "two" },
    ]);
    emit("two", "text_delta", { delta: "Rendering" });
    emit("one", "tool_result", { toolCallId: "call", output: "Written" });
    emit("two", "text_delta", { delta: " now" });
    const latest = read(root, tasks);
    expect(latest).toMatchObject([
      { progress: { title: "Write rig.py", text: "Written", status: "done" } },
      { progress: { text: "Rendering now" } },
    ]);
    expect(read(root, tasks)).toEqual(latest);
    emit("one", "task_completed");
    expect(read(root, tasks).map(task => task.id)).toEqual(["two"]);
  });

  test("older independent tasks recover their latest result from the child journal", () => {
    const childSession = "child-123a";
    const dir = path.join(root, ".ufoo/agent/main-task/runtimes", childSession);
    fs.mkdirSync(dir, { recursive: true });
    const task = { id: "task_123", status: "queued", childSession };
    const file = path.join(dir, "events.jsonl");
    const write = event => fs.appendFileSync(file, JSON.stringify({ taskRunId: task.id, ...event }) + "\n");
    write({ type: "tool.started", toolCallId: "c", toolName: "bash", args: { command: "pwd" } });
    write({ type: "tool.completed", toolCallId: "c", result: { ok: false, stderrTail: "failed" } });
    const read = createBackgroundTaskProgress();
    expect(read(root, [task])[0].progress).toMatchObject({ title: "Bash pwd", status: "failed", text: "failed" });
    write({ type: "message.delta", text: "Retrying" });
    expect(read(root, [task])[0].progress).toEqual({ kind: "text", text: "Retrying" });
    write({ type: "task.completed" });
    expect(read(root, [task])).toEqual([]);
  });
});
