const fs = require("fs");
const os = require("os");
const path = require("path");

const { shakeTerminalByTty } = require("../../../src/bus/shake");

describe("shakeTerminalByTty", () => {
  test("returns false when ttyPath is falsy", () => {
    expect(shakeTerminalByTty(null)).toBe(false);
    expect(shakeTerminalByTty("")).toBe(false);
    expect(shakeTerminalByTty(undefined)).toBe(false);
  });

  test("returns false when ttyPath does not exist or is not writable", () => {
    expect(shakeTerminalByTty("/nonexistent/tty/path")).toBe(false);
  });

  test("writes bell character to valid writable path", () => {
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-shake-")),
      "tty"
    );
    fs.writeFileSync(tmpFile, "");
    const result = shakeTerminalByTty(tmpFile);
    expect(result).toBe(true);
    const content = fs.readFileSync(tmpFile, "utf8");
    expect(content).toBe("\x07");
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });
});
