"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { IPC_RESPONSE_TYPES } = require("../../../src/shared/eventContract");
const { handlePromptRequest } = require("../../../src/daemon/promptRequest");
const {
  getLoopObservabilityPaths,
  getShadowObservabilityPaths,
} = require("../../../src/agent/loopObservability");
const { resetAppliedControllerModesForTests } = require("../../../src/controller/flags");

jest.mock("../../../src/projects", () => ({
  isGlobalControllerProjectRoot: jest.fn(() => false),
}));

function parseWritePayload(writeCallArg) {
  const line = String(writeCallArg || "").trim();
  return JSON.parse(line);
}

describe("daemon promptRequest loop mode", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAppliedControllerModesForTests();
    delete process.env.UFOO_AGENT_RUNTIME_MODE;
    delete process.env.UFOO_AGENT_ENABLE_LOOP;
    delete process.env.UFOO_CONTROLLER_MODE;
  });

  afterEach(() => {
    delete process.env.UFOO_AGENT_RUNTIME_MODE;
    delete process.env.UFOO_AGENT_ENABLE_LOOP;
    delete process.env.UFOO_CONTROLLER_MODE;
  });

  test("routes through controller loop runner when loop controller mode is enabled", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-prompt-loop-"));
    process.env.UFOO_CONTROLLER_MODE = "loop";
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn();
    const runPromptWithControllerLoop = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "loop done", dispatch: [], ops: [], loop: { terminal_reason: "completed" } },
      opsResults: [],
    });

    const ok = await handlePromptRequest({
      projectRoot,
      req: { text: "run task", request_id: "msg-loop-1" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runPromptWithControllerLoop,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runPromptWithAssistant).not.toHaveBeenCalled();
    expect(runPromptWithControllerLoop).toHaveBeenCalledWith(expect.objectContaining({
      loopRuntime: expect.objectContaining({
        enabled: true,
        maxRounds: 3,
      }),
    }));
    const msg = parseWritePayload(socket.write.mock.calls[0][0]);
    expect(msg).toEqual({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: { reply: "loop done", dispatch: [], ops: [], loop: { terminal_reason: "completed" } },
      opsResults: [],
    });

    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((row) => row.event === "controller.prompt_path_selected" && row.loop_enabled === true)).toBe(true);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("shadow mode keeps legacy response primary and records shadow diff without local side effects", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-prompt-shadow-"));
    process.env.UFOO_CONTROLLER_MODE = "shadow";
    const socket = { write: jest.fn() };
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);
    const ackBus = jest.fn().mockResolvedValue(1);
    const markPending = jest.fn();
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "legacy reply", dispatch: [], ops: [] },
      opsResults: [],
    });
    const runPromptWithControllerLoop = jest.fn().mockImplementation(async (args) => {
      await args.dispatchMessages(projectRoot, [{ target: "reviewer", message: "shadow dispatch" }]);
      await args.handleOps(projectRoot, [{ action: "launch", agent: "codex" }], null);
      await args.ackBus(projectRoot, "ufoo-agent");
      args.markPending("reviewer");
      return {
        ok: true,
        payload: { reply: "shadow reply", dispatch: [], ops: [], loop: { terminal_reason: "completed" } },
        opsResults: [],
      };
    });

    const ok = await handlePromptRequest({
      projectRoot,
      req: {
        text: "run task",
        request_id: "msg-shadow-1",
        request_meta: { shadow_sampling_rate: 1 },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runPromptWithControllerLoop,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages,
      handleOps,
      ackBus,
      markPending,
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runPromptWithAssistant).toHaveBeenCalledTimes(1);
    expect(runPromptWithControllerLoop).toHaveBeenCalledWith(expect.objectContaining({
      finalizeLocally: false,
      loopRuntime: expect.objectContaining({ enabled: true }),
    }));
    expect(dispatchMessages).not.toHaveBeenCalled();
    expect(handleOps).not.toHaveBeenCalled();
    expect(ackBus).not.toHaveBeenCalled();
    expect(markPending).not.toHaveBeenCalled();
    expect(parseWritePayload(socket.write.mock.calls[0][0])).toEqual({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: { reply: "legacy reply", dispatch: [], ops: [] },
      opsResults: [],
    });

    const { diffFile } = getShadowObservabilityPaths(projectRoot);
    const diffRows = fs.readFileSync(diffFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(diffRows).toHaveLength(1);
    expect(diffRows[0]).toEqual(expect.objectContaining({
      event: "controller.shadow.diff",
      shadow_only: true,
      request_id: "msg-shadow-1",
      primary_mode: "legacy",
      candidate_mode: "loop",
      side_effects_ok: true,
    }));

    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((row) => row.event === "controller.shadow.started" && row.shadow_only === true)).toBe(true);
    expect(events.some((row) => row.event === "controller.shadow.completed" && row.shadow_only === true)).toBe(true);
    expect(events.some((row) => row.event === "controller.shadow.violation")).toBe(false);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("shadow mode skips shadow run when sampling rate is zero", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-prompt-shadow-skip-"));
    process.env.UFOO_CONTROLLER_MODE = "shadow";
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "legacy reply", dispatch: [], ops: [] },
      opsResults: [],
    });
    const runPromptWithControllerLoop = jest.fn();

    const ok = await handlePromptRequest({
      projectRoot,
      req: {
        text: "run task",
        request_id: "msg-shadow-skip",
        request_meta: { shadow_sampling_rate: 0 },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runPromptWithControllerLoop,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runPromptWithControllerLoop).not.toHaveBeenCalled();
    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((row) => row.event === "controller.shadow.skipped"
      && row.reason === "sampling_excluded"
      && row.shadow_only === true)).toBe(true);
    expect(events.some((row) => row.event === "controller.shadow.started")).toBe(false);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("shadow mode assertion flags side effects when runner mutates bus queue", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-prompt-shadow-violate-"));
    process.env.UFOO_CONTROLLER_MODE = "shadow";
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "legacy reply", dispatch: [], ops: [] },
      opsResults: [],
    });

    const busQueueDir = path.join(projectRoot, ".ufoo", "bus", "queues", "codex_1");
    fs.mkdirSync(busQueueDir, { recursive: true });
    fs.writeFileSync(path.join(busQueueDir, "pending.jsonl"), "{}\n");

    const runPromptWithControllerLoop = jest.fn().mockImplementation(async () => {
      fs.appendFileSync(path.join(busQueueDir, "pending.jsonl"), "{\"event\":\"leak\"}\n");
      return {
        ok: true,
        payload: { reply: "shadow", dispatch: [], ops: [], loop: { terminal_reason: "final_answer" } },
        opsResults: [],
      };
    });

    const ok = await handlePromptRequest({
      projectRoot,
      req: {
        text: "run task",
        request_id: "msg-shadow-violate",
        request_meta: { shadow_sampling_rate: 1 },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runPromptWithControllerLoop,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const violation = events.find((row) => row.event === "controller.shadow.violation");
    expect(violation).toBeDefined();
    expect(violation.violations.some((v) => v.scope === "bus_queue")).toBe(true);
    const { diffFile } = getShadowObservabilityPaths(projectRoot);
    const diffRows = fs.readFileSync(diffFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(diffRows[0].side_effects_ok).toBe(false);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});
