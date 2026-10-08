const { probeNativeCapabilities } = require("../../../src/agents/launch/nativeCapabilities");

describe("native CLI capabilities", () => {
  test("missing or older CLIs remain unsupported", () => {
    expect(probeNativeCapabilities({ agentType: "codex", spawnSyncImpl: () => ({ error: { code: "ENOENT" } }) })).toMatchObject({ supported: false, reason: "cli_missing" });
    expect(probeNativeCapabilities({ agentType: "claude-code", spawnSyncImpl: () => ({ status: 0, stdout: "2.1.10 (Claude Code)" }) })).toMatchObject({ supported: false, version: "2.1.10" });
  });
  test("Codex requires remote/app-server support and a tested version", () => {
    const spawn = jest.fn().mockReturnValueOnce({ status: 0, stdout: "codex-cli 0.160.1" }).mockReturnValueOnce({ status: 0, stdout: "app-server --remote" });
    expect(probeNativeCapabilities({ agentType: "codex", spawnSyncImpl: spawn }).supported).toBe(true);
    const incompatible = jest.fn().mockReturnValueOnce({ status: 0, stdout: "codex-cli 0.160.1" }).mockReturnValueOnce({ status: 0, stdout: "old help" });
    expect(probeNativeCapabilities({ agentType: "codex", spawnSyncImpl: incompatible })).toMatchObject({ supported: false, reason: "missing_remote_app_server" });
  });
});
