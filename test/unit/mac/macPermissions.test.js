"use strict";

jest.mock("../../../src/runtime/mac/helperCompiler", () => ({
  runHelperCheck: jest.fn(async () => ({ permissions: { accessibility: true, screenRecording: true } })),
}));
jest.mock("../../../src/runtime/mac/helperClient", () => ({ stopHelperDaemon: jest.fn(async () => ({})) }));

const { runHelperCheck } = require("../../../src/runtime/mac/helperCompiler");
const { runMacCommand } = require("../../../src/app/cli/macCommands");
const { runCli } = require("../../../src/app/cli/run");

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  jest.restoreAllMocks();
});

test.each([{ flags: [] }, { flags: ["--no-open"] }])("Commander permission flags $flags reach the native permission check", async ({ flags }) => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  // The command defaults to the host platform; non-Mac machines cannot prompt.
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  await runCli(["node", "ufoo", "mac", "permissions", ...flags, "--json"]);
  expect(runHelperCheck).toHaveBeenLastCalledWith(expect.objectContaining({
    prompt: true, openSettings: !flags.includes("--no-open"),
  }));
});

test("fallback parser's noOpen flag suppresses opening settings too", async () => {
  await runMacCommand("permissions", [], { noOpen: true }, { platform: "darwin", write: () => {} });
  expect(runHelperCheck).toHaveBeenLastCalledWith(expect.objectContaining({ openSettings: false }));
});
