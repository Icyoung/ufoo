describe("wrapper launch request context", () => {
test("collectHostLaunchRequestContext collects env vars", () => {
    const { collectHostLaunchRequestContext } = require("../../../src/app/chat/launchRequestContext");
    const ctx = collectHostLaunchRequestContext({
      UFOO_HOST_INJECT_SOCK: "/tmp/inject.sock",
      UFOO_HOST_DAEMON_SOCK: "/tmp/daemon.sock",
      UFOO_HOST_NAME: "horizon",
      UFOO_HOST_SESSION_ID: "sess-1",
    });
    expect(ctx.host_inject_sock).toBe("/tmp/inject.sock");
    expect(ctx.host_daemon_sock).toBe("/tmp/daemon.sock");
    expect(ctx.host_name).toBe("horizon");
    expect(ctx.host_session_id).toBe("sess-1");
  });

test("collectHostLaunchRequestContext returns empty for missing vars", () => {
    const { collectHostLaunchRequestContext } = require("../../../src/app/chat/launchRequestContext");
    const ctx = collectHostLaunchRequestContext({});
    expect(Object.keys(ctx)).toHaveLength(0);
  });

test("collectHostLaunchRequestContext uses HORIZON fallbacks", () => {
    const { collectHostLaunchRequestContext } = require("../../../src/app/chat/launchRequestContext");
    const ctx = collectHostLaunchRequestContext({
      HORIZON_INJECT_SOCK: "/tmp/h-inject.sock",
      HORIZON_SESSION_ID: "h-sess",
    });
    expect(ctx.host_inject_sock).toBe("/tmp/h-inject.sock");
    expect(ctx.host_session_id).toBe("h-sess");
  });
});
