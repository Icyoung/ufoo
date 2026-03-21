const os = require("os");
const path = require("path");
const {
  normalizeProjectRoot,
  resolveGlobalControllerProjectRoot,
  resolveGlobalControllerUfooDir,
  isGlobalControllerProjectRoot,
} = require("../../src/globalMode");

describe("globalMode helpers", () => {
  test("resolveGlobalControllerProjectRoot anchors global chat to the home directory", () => {
    expect(resolveGlobalControllerProjectRoot()).toBe(path.resolve(os.homedir()));
    expect(resolveGlobalControllerUfooDir()).toBe(path.join(path.resolve(os.homedir()), ".ufoo"));
  });

  test("isGlobalControllerProjectRoot matches home-root aliases", () => {
    const home = path.resolve(os.homedir());
    expect(isGlobalControllerProjectRoot(home)).toBe(true);
    expect(isGlobalControllerProjectRoot(`${home}/`)).toBe(true);
    expect(isGlobalControllerProjectRoot("/tmp/not-home")).toBe(false);
  });

  test("normalizeProjectRoot trims trailing slashes for existing paths", () => {
    const home = path.resolve(os.homedir());
    expect(normalizeProjectRoot(`${home}/`)).toBe(home);
  });
});
