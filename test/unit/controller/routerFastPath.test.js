"use strict";

const {
  classifyPromptIntent,
  normalizeGateRouterResult,
  resolveExecutionPath,
  resolveGateRouterConfig,
  shouldUseGateRouter,
} = require("../../../src/controller/routerFastPath");

describe("controller gateRouter", () => {
  test("classifies pure routing prompts", () => {
    expect(classifyPromptIntent("Who should handle this follow-up?")).toEqual({
      kind: "routing",
      reason: "routing_signal",
    });
    expect(classifyPromptIntent("Send this to architect")).toEqual({
      kind: "routing",
      reason: "routing_signal",
    });
    expect(classifyPromptIntent("发送这个给builder")).toEqual({
      kind: "routing",
      reason: "routing_signal",
    });
    expect(classifyPromptIntent("让 builder 接这个任务")).toEqual({
      kind: "routing",
      reason: "routing_signal",
    });
  });

  test("keeps execution requests off the gate router", () => {
    expect(classifyPromptIntent("Send this to architect and fix the flaky test")).toEqual({
      kind: "general",
      reason: "contains_execution_language",
    });
    expect(classifyPromptIntent("Implement the router fast path")).toEqual({
      kind: "general",
      reason: "no_routing_signal",
    });
    expect(classifyPromptIntent("发送这个给 builder 并修正文档")).toEqual({
      kind: "general",
      reason: "contains_execution_language",
    });
  });

  test("resolves execution path from request metadata before env or config", () => {
    const loadConfigImpl = jest.fn(() => ({ agentExecutionPath: "legacy" }));
    const result = resolveExecutionPath({
      projectRoot: "/tmp/project",
      requestMeta: { agent_execution_path: "router-api" },
      env: { UFOO_AGENT_EXECUTION_PATH: "loop" },
      loadConfigImpl,
    });

    expect(result).toBe("router-api");
  });

  test("enables gate router for router-api requests regardless of prompt intent", () => {
    const loadConfigImpl = jest.fn(() => ({ agentExecutionPath: "router-api" }));

    expect(shouldUseGateRouter({
      projectRoot: "/tmp/project",
      prompt: "Continue with reviewer on the current thread",
      loadConfigImpl,
      env: {},
    })).toEqual({
      executionPath: "router-api",
      intent: { kind: "routing", reason: "routing_signal" },
      enabled: true,
    });

    expect(shouldUseGateRouter({
      projectRoot: "/tmp/project",
      prompt: "Fix the router tests",
      loadConfigImpl,
      env: {},
    })).toEqual({
      executionPath: "router-api",
      intent: { kind: "general", reason: "no_routing_signal" },
      enabled: true,
    });
  });

  test("accepts controllerMode as the persisted gate-router config key", () => {
    const loadConfigImpl = jest.fn(() => ({ controllerMode: "router-api" }));

    expect(resolveExecutionPath({
      projectRoot: "/tmp/project",
      loadConfigImpl,
      env: {},
    })).toBe("router-api");

    expect(shouldUseGateRouter({
      projectRoot: "/tmp/project",
      prompt: "Send this to reviewer",
      loadConfigImpl,
      env: {},
    })).toEqual({
      executionPath: "router-api",
      intent: { kind: "routing", reason: "routing_signal" },
      enabled: true,
    });
  });

  test("resolves gate-router config overrides and normalizes route results", () => {
    const loadConfigImpl = jest.fn(() => ({
      routerProvider: "anthropic",
      routerModel: "claude-haiku",
      routerTimeoutMs: 9000,
      routerConfidenceThreshold: 0.72,
    }));

    expect(resolveGateRouterConfig({
      projectRoot: "/tmp/project",
      env: {},
      loadConfigImpl,
    })).toEqual({
      provider: "anthropic",
      model: "claude-haiku",
      timeoutMs: 9000,
      confidenceThreshold: 0.72,
    });

    expect(normalizeGateRouterResult({
      target: "reviewer",
      confidence: 3,
      reason: "continuity",
      injection_mode: "queued",
    }, "Route this")).toEqual({
      decision: "direct_dispatch",
      target: "reviewer",
      confidence: 1,
      reason: "continuity",
      message: "Route this",
      injection_mode: "queued",
    });
  });

  test("supports loop mode as a gate-router front door and normalizes upgrades to main router", () => {
    const loadConfigImpl = jest.fn(() => ({ controllerMode: "loop" }));

    expect(shouldUseGateRouter({
      projectRoot: "/tmp/project",
      prompt: "Review the current codebase",
      loadConfigImpl,
      env: {},
    })).toEqual({
      executionPath: "loop",
      intent: { kind: "general", reason: "no_routing_signal" },
      enabled: true,
    });

    expect(normalizeGateRouterResult({
      decision: "upgrade_to_main_router",
      target: "unknown",
      confidence: 0.25,
      reason: "needs tool-assisted exploration",
    }, "Review the current codebase")).toEqual({
      decision: "upgrade_to_main_router",
      target: "unknown",
      confidence: 0.25,
      reason: "needs tool-assisted exploration",
      message: "Review the current codebase",
      injection_mode: "immediate",
    });
  });
});
