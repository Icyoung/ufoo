const {
  COMMAND_REGISTRY,
  buildCommandRegistry,
  parseCommand,
  parseAtTarget,
} = require("../../../src/chat/commands");

describe("chat command helpers", () => {
  test("COMMAND_REGISTRY keeps priority order for launch/bus/ctx", () => {
    const cmds = COMMAND_REGISTRY.map((item) => item.cmd);
    expect(cmds.indexOf("/launch")).toBeLessThan(cmds.indexOf("/bus"));
    expect(cmds.indexOf("/bus")).toBeLessThan(cmds.indexOf("/ctx"));
  });

  test("buildCommandRegistry sorts subcommands alphabetically", () => {
    const tree = {
      "/z": { desc: "z", children: { beta: { desc: "" }, alpha: { desc: "" } } },
    };
    const registry = buildCommandRegistry(tree);
    expect(registry).toHaveLength(1);
    expect(registry[0].subcommands.map((s) => s.cmd)).toEqual(["alpha", "beta"]);
  });

  test("launch command exposes ucode subcommand", () => {
    const launch = COMMAND_REGISTRY.find((item) => item.cmd === "/launch");
    expect(launch).toBeTruthy();
    expect((launch.subcommands || []).some((sub) => sub.cmd === "ucode")).toBe(true);
  });

  test("settings command exposes ucode subsection", () => {
    const settings = COMMAND_REGISTRY.find((item) => item.cmd === "/settings");
    expect(settings).toBeTruthy();
    expect((settings.subcommands || []).some((sub) => sub.cmd === "ucode")).toBe(true);
  });

  test("cron command is exposed", () => {
    const cron = COMMAND_REGISTRY.find((item) => item.cmd === "/cron");
    expect(cron).toBeTruthy();
    expect((cron.subcommands || []).some((sub) => sub.cmd === "start")).toBe(true);
    expect((cron.subcommands || []).some((sub) => sub.cmd === "list")).toBe(true);
    expect((cron.subcommands || []).some((sub) => sub.cmd === "stop")).toBe(true);
  });

  test("ucodeconfig command is not exposed", () => {
    const ucodeconfig = COMMAND_REGISTRY.find((item) => item.cmd === "/ucodeconfig");
    expect(ucodeconfig).toBeFalsy();
  });

  test("ufoo command is exposed", () => {
    const ufoo = COMMAND_REGISTRY.find((item) => item.cmd === "/ufoo");
    expect(ufoo).toBeTruthy();
    expect(ufoo.desc).toBe("ufoo protocol (session marker)");
  });

  test("parseCommand handles quoted args", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/launch codex \"nickname with space\"")).toEqual({
      command: "launch",
      args: ["codex", "nickname with space"],
    });
  });

  test("parseAtTarget extracts target and optional message", () => {
    expect(parseAtTarget("hello")).toBeNull();
    expect(parseAtTarget("@codex")).toEqual({ target: "codex", message: "" });
    expect(parseAtTarget("@codex hi there")).toEqual({ target: "codex", message: "hi there" });
  });
});
