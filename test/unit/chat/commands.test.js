const {
  COMMAND_REGISTRY,
  buildCommandRegistry,
  parseCommand,
  shouldEchoCommandInChat,
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
    expect((settings.subcommands || []).some((sub) => sub.cmd === "show")).toBe(true);
    expect((settings.subcommands || []).some((sub) => sub.cmd === "agent")).toBe(true);
    expect((settings.subcommands || []).some((sub) => sub.cmd === "router")).toBe(true);
    expect((settings.subcommands || []).some((sub) => sub.cmd === "ucode")).toBe(true);
    const agent = (settings.subcommands || []).find((sub) => sub.cmd === "agent");
    expect((agent.subcommands || []).map((sub) => sub.cmd)).toEqual([
      "show",
      "set",
      "clear",
      "codex",
      "claude",
    ]);
    const router = (settings.subcommands || []).find((sub) => sub.cmd === "router");
    expect((router.subcommands || []).map((sub) => sub.cmd)).toEqual([
      "show",
      "set",
      "clear",
      "main",
      "loop",
      "legacy",
      "shadow",
      "codex",
      "claude",
    ]);
  });

  test("cron command is exposed", () => {
    const cron = COMMAND_REGISTRY.find((item) => item.cmd === "/cron");
    expect(cron).toBeTruthy();
    expect((cron.subcommands || []).some((sub) => sub.cmd === "start")).toBe(true);
    expect((cron.subcommands || []).some((sub) => sub.cmd === "list")).toBe(true);
    expect((cron.subcommands || []).some((sub) => sub.cmd === "stop")).toBe(true);
  });

  test("group command is exposed", () => {
    const group = COMMAND_REGISTRY.find((item) => item.cmd === "/group");
    expect(group).toBeTruthy();
    expect((group.subcommands || []).some((sub) => sub.cmd === "run")).toBe(true);
    expect(group.subcommands[0].cmd).toBe("run");
    expect(group.subcommands[1].cmd).toBe("diagram");
    expect((group.subcommands || []).some((sub) => sub.cmd === "status")).toBe(true);
    expect((group.subcommands || []).some((sub) => sub.cmd === "stop")).toBe(true);
    expect((group.subcommands || []).some((sub) => sub.cmd === "template")).toBe(true);
  });

  test("project command is exposed for switch spike", () => {
    const project = COMMAND_REGISTRY.find((item) => item.cmd === "/project");
    expect(project).toBeTruthy();
    expect((project.subcommands || []).some((sub) => sub.cmd === "list")).toBe(true);
    expect((project.subcommands || []).some((sub) => sub.cmd === "current")).toBe(true);
    expect((project.subcommands || []).some((sub) => sub.cmd === "switch")).toBe(true);
  });

  test("role command is exposed with list subcommand", () => {
    const role = COMMAND_REGISTRY.find((item) => item.cmd === "/role");
    expect(role).toBeTruthy();
    expect(role.desc).toBe("Assign preset role to an existing agent");
    expect((role.subcommands || []).some((sub) => sub.cmd === "assign")).toBe(true);
    expect((role.subcommands || []).some((sub) => sub.cmd === "list")).toBe(true);
  });

  test("solo command is exposed with run and list subcommands", () => {
    const solo = COMMAND_REGISTRY.find((item) => item.cmd === "/solo");
    expect(solo).toBeTruthy();
    expect(solo.desc).toBe("Solo role agent operations");
    expect((solo.subcommands || []).some((sub) => sub.cmd === "run")).toBe(true);
    expect((solo.subcommands || []).some((sub) => sub.cmd === "list")).toBe(true);
  });

  test("open command is exposed", () => {
    const open = COMMAND_REGISTRY.find((item) => item.cmd === "/open");
    expect(open).toBeTruthy();
    expect(open.desc).toBe("Open project path in global mode");
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

  test("shouldEchoCommandInChat suppresses group run echoes only", () => {
    expect(shouldEchoCommandInChat("/group run build-lane")).toBe(false);
    expect(shouldEchoCommandInChat("/group status build-lane")).toBe(true);
    expect(shouldEchoCommandInChat("/status")).toBe(true);
  });
});
