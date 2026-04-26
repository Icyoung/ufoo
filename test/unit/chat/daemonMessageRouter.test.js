const { createDaemonMessageRouter } = require("../../../src/chat/daemonMessageRouter");
const { IPC_RESPONSE_TYPES, BUS_STATUS_PHASES } = require("../../../src/shared/eventContract");

function createHarness(overrides = {}) {
  let pending = null;
  const options = {
    escapeBlessed: jest.fn((v) => `ESC(${v})`),
    stripBlessedTags: jest.fn((v) => String(v || "").replace(/\{[^}]+\}/g, "")),
    logMessage: jest.fn(),
    renderScreen: jest.fn(),
    updateDashboard: jest.fn(),
    requestStatus: jest.fn(),
    resolveStatusLine: jest.fn(),
    enqueueBusStatus: jest.fn(),
    resolveBusStatus: jest.fn(),
    getPending: jest.fn(() => pending),
    setPending: jest.fn((value) => {
      pending = value;
    }),
    resolveAgentDisplayName: jest.fn((v) => `name:${v}`),
    getCurrentView: jest.fn(() => "main"),
    isAgentViewUsesBus: jest.fn(() => false),
    getViewingAgent: jest.fn(() => ""),
    writeToAgentTerm: jest.fn(),
    consumePendingDelivery: jest.fn(() => false),
    getPendingState: jest.fn(() => null),
    beginStream: jest.fn(() => ({ state: true })),
    appendStreamDelta: jest.fn(),
    finalizeStream: jest.fn(),
    hasStream: jest.fn(() => false),
    setTransientAgentState: jest.fn(),
    clearTransientAgentState: jest.fn(),
    refreshDashboard: jest.fn(),
    ...overrides,
  };

  const router = createDaemonMessageRouter(options);
  return { router, options, getPending: () => pending };
}

describe("chat daemonMessageRouter", () => {
  test("handles status phase messages", () => {
    const { router, options } = createHarness();

    const stop = router.handleMessage({
      type: IPC_RESPONSE_TYPES.STATUS,
      data: { phase: BUS_STATUS_PHASES.START, key: "k1", text: "processing" },
    });

    expect(stop).toBe(false);
    expect(options.enqueueBusStatus).toHaveBeenCalledWith({ key: "k1", text: "processing" });
    expect(options.renderScreen).toHaveBeenCalled();
  });

  test("status START marks transient agent working for subscriber key", () => {
    const { router, options } = createHarness();
    router.handleMessage({
      type: IPC_RESPONSE_TYPES.STATUS,
      data: { phase: BUS_STATUS_PHASES.START, key: "codex:1", text: "processing" },
    });
    expect(options.setTransientAgentState).toHaveBeenCalledWith("codex:1", "working");
    expect(options.refreshDashboard).toHaveBeenCalled();
  });

  test("status DONE clears transient agent state for subscriber key", () => {
    const { router, options } = createHarness();
    router.handleMessage({
      type: IPC_RESPONSE_TYPES.STATUS,
      data: { phase: BUS_STATUS_PHASES.DONE, key: "codex:1", text: "done" },
    });
    expect(options.clearTransientAgentState).toHaveBeenCalledWith("codex:1");
    expect(options.refreshDashboard).toHaveBeenCalled();
  });

  test("handles response disambiguate payload", () => {
    const { router, options, getPending } = createHarness({
      getPending: jest.fn(() => ({ original: "task" })),
    });

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        disambiguate: {
          prompt: "Pick",
          candidates: [{ agent_id: "codex:1", reason: "best" }],
        },
      },
    });

    expect(getPending()).toEqual({
      disambiguate: {
        prompt: "Pick",
        candidates: [{ agent_id: "codex:1", reason: "best" }],
      },
      original: "task",
    });
    expect(options.resolveStatusLine).toHaveBeenCalledWith("{gray-fg}?{/gray-fg} ESC(Pick)");
    expect(options.logMessage).toHaveBeenCalled();
  });

  test("response disambiguate payload preserves routed project root", () => {
    const { router, getPending } = createHarness({
      getPending: jest.fn(() => ({ original: "task" })),
    });

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        routed_project: { project_root: "/tmp/project-a", project_name: "alpha" },
        disambiguate: {
          prompt: "Pick",
          candidates: [{ agent_id: "codex:1", reason: "best" }],
        },
      },
    });

    expect(getPending()).toEqual({
      disambiguate: {
        prompt: "Pick",
        candidates: [{ agent_id: "codex:1", reason: "best" }],
      },
      original: "task",
      project_root: "/tmp/project-a",
    });
  });

  test("agent view bus passthrough writes to term and stops processing", () => {
    const { router, options } = createHarness({
      getCurrentView: jest.fn(() => "agent"),
      isAgentViewUsesBus: jest.fn(() => true),
      getViewingAgent: jest.fn(() => "codex:1"),
    });

    const stop = router.handleMessage({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "message",
        publisher: "codex:1",
        message: "hello",
      },
    });

    expect(stop).toBe(true);
    expect(options.writeToAgentTerm).toHaveBeenCalledWith("hello\r\n");
  });

  test("agent view bus passthrough decodes escaped newlines", () => {
    const { router, options } = createHarness({
      getCurrentView: jest.fn(() => "agent"),
      isAgentViewUsesBus: jest.fn(() => true),
      getViewingAgent: jest.fn(() => "codex:1"),
    });

    const stop = router.handleMessage({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "message",
        publisher: "codex:1",
        message: "hello\\nworld",
      },
    });

    expect(stop).toBe(true);
    expect(options.writeToAgentTerm).toHaveBeenCalledWith("hello\nworld\r\n");
  });

  test("delivery event consumes pending and requests status without logging to chat", () => {
    const { router, options } = createHarness({
      consumePendingDelivery: jest.fn(() => true),
    });

    const stop = router.handleMessage({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "delivery",
        publisher: "codex:1",
        status: "ok",
        message: "delivered",
      },
    });

    expect(stop).toBe(true);
    // Delivery confirmations are suppressed from chat (shown in status bar only)
    expect(options.logMessage).not.toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
    expect(options.renderScreen).toHaveBeenCalled();
  });

  test("activity_state_changed bus event triggers status refresh without logging", () => {
    const { router, options } = createHarness();

    const stop = router.handleMessage({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "activity_state_changed",
        publisher: "codex:1",
        state: "waiting_input",
      },
    });

    expect(stop).toBe(true);
    expect(options.requestStatus).toHaveBeenCalledTimes(1);
    expect(options.logMessage).not.toHaveBeenCalled();
  });

  test("controller_report bus event inserts chat record and refreshes status", () => {
    const { router, options } = createHarness();

    const stop = router.handleMessage({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "controller_report",
        publisher: "codex:1",
        report: {
          agent_id: "codex:1",
          summary: "Discovery brief delivered",
          task_id: "brief-1",
        },
      },
    });

    expect(stop).toBe(true);
    expect(options.logMessage).toHaveBeenCalledWith(
      "bus",
      "{cyan-fg}ESC(name:codex:1){/cyan-fg} {gray-fg}·{/gray-fg} ESC(Discovery brief delivered)"
    );
    expect(options.requestStatus).toHaveBeenCalledTimes(1);
    expect(options.renderScreen).toHaveBeenCalledTimes(1);
  });

  test("response reply decodes escaped newlines before rendering", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "line1\\nline2",
      },
    });

    expect(options.resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}←{/gray-fg} ESC(line1\nline2)"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "reply",
      "{white-fg}ESC(ufoo){/white-fg} {gray-fg}·{/gray-fg} ESC(line1\nline2)"
    );
  });

  test("stream payload routes through stream tracker methods", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "message",
        publisher: "codex:1",
        message: JSON.stringify({ stream: true, delta: "A", done: true, reason: "end" }),
      },
    });

    expect(options.beginStream).toHaveBeenCalled();
    expect(options.appendStreamDelta).toHaveBeenCalled();
    expect(options.finalizeStream).toHaveBeenCalledWith("codex:1", expect.any(Object), "end");
  });

  test("response with recoverable payload logs recoverable and skipped entries", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Found 1 recoverable agent(s)",
        recoverable: {
          recoverable: [
            {
              id: "codex:abc",
              nickname: "codex-3",
              agent: "codex",
              launchMode: "terminal",
            },
          ],
          skipped: [
            { id: "claude-code:def", reason: "no provider session" },
          ],
        },
      },
    });

    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "{cyan-fg}Recoverable agents:{/cyan-fg}"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      expect.stringContaining("ESC(codex:abc (codex-3) [codex/terminal])")
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "{gray-fg}Skipped:{/gray-fg}"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      expect.stringContaining("ESC(claude-code:def: no provider session)")
    );
  });

  test("handles error messages", () => {
    const { router, options } = createHarness();

    router.handleMessage({ type: "error", error: "boom" });

    expect(options.resolveStatusLine).toHaveBeenCalledWith("{gray-fg}✗{/gray-fg} Error: boom");
    expect(options.logMessage).not.toHaveBeenCalledWith(
      "error",
      expect.anything()
    );
  });

  test("response with close op triggers status refresh", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Closed codex:1",
        ops: [{ action: "close", agent_id: "codex:1" }],
      },
    });

    expect(options.requestStatus).toHaveBeenCalled();
  });

  test("response with cron list renders cron summaries", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        cron: {
          ok: true,
          operation: "list",
          count: 1,
          tasks: [{ id: "c1", summary: "c1@once(2026-02-23 22:15)->codex:1: run once" }],
        },
        ops: [{ action: "cron", operation: "list" }],
      },
    });

    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "{cyan-fg}Cron:{/cyan-fg} 1 task(s)"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "  • ESC(c1@once(2026-02-23 22:15)->codex:1: run once)"
    );
    expect(options.requestStatus).toHaveBeenCalled();
  });

  test("response with group list renders group summaries", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Group instances: 1",
        group: {
          ok: true,
          count: 1,
          groups: [
            {
              group_id: "dev-basic-ab12",
              status: "active",
              template_alias: "dev-basic",
              members_active: 2,
              members_total: 2,
            },
          ],
        },
      },
    });

    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "{cyan-fg}Groups:{/cyan-fg} 1"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "  • ESC(dev-basic-ab12) [ESC(active)] ESC(dev-basic) active=2/2"
    );
  });

  test("response with group start keeps status line but suppresses reply history", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Group started build-lane-mnfurxqc-2wjm",
        group: {
          group_id: "build-lane-mnfurxqc-2wjm",
          status: "active",
          template_alias: "build-lane",
          members: [
            { nickname: "builder", type: "codex", status: "active", subscriber_id: "codex:1" },
          ],
        },
      },
    });

    expect(options.resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}←{/gray-fg} ESC(Group started build-lane-mnfurxqc-2wjm)"
    );
    expect(options.logMessage).not.toHaveBeenCalledWith(
      "reply",
      "{white-fg}ESC(ufoo){/white-fg} {gray-fg}·{/gray-fg} ESC(Group started build-lane-mnfurxqc-2wjm)"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "{cyan-fg}Group:{/cyan-fg} ESC(build-lane-mnfurxqc-2wjm) [ESC(active)] ESC(build-lane)"
    );
  });

  test("response with invalid group template renders validation errors", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Template invalid",
        group: {
          ok: false,
          target: "broken.json",
          errors: [
            { path: "agents[0].type", message: "type must be one of codex|claude|ucode" },
          ],
        },
      },
    });

    expect(options.logMessage).toHaveBeenCalledWith(
      "error",
      "{white-fg}✗{/white-fg} Group template invalid: ESC(broken.json)"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "error",
      "  - ESC(agents[0].type: type must be one of codex|claude|ucode)"
    );
  });

  test("response with invalid group template renders loader errors {filePath,error}", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Template invalid",
        group: {
          ok: false,
          target: "dev-basic",
          errors: [
            { filePath: "/tmp/dev-basic.json", error: "invalid JSON: Unexpected end of JSON input" },
          ],
        },
      },
    });

    expect(options.logMessage).toHaveBeenCalledWith(
      "error",
      "  - ESC(/tmp/dev-basic.json: invalid JSON: Unexpected end of JSON input)"
    );
  });

  test("response with group diagram renders diagram lines", () => {
    const { router, options } = createHarness();

    router.handleMessage({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "Group diagram",
        group: {
          ok: true,
          mode: "template",
          format: "ascii",
          diagram: "Group Diagram (template: dev-basic)\nMembers (1):\n- pm [claude] order=1 deps=-",
        },
      },
    });

    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "{cyan-fg}Group diagram:{/cyan-fg} ESC(template ascii)"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "ESC(Group Diagram (template: dev-basic))"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "ESC(Members (1):)"
    );
    expect(options.logMessage).toHaveBeenCalledWith(
      "system",
      "ESC(- pm [claude] order=1 deps=-)"
    );
  });
});
