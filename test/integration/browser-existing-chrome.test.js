"use strict";

// Explicit opt-in: this launches a disposable Chrome fixture, never the user's profile.
const describeBrowser = process.env.UFOO_TEST_BROWSER === "1" ? describe : describe.skip;
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createBrowserSessions } = require("../../src/runtime/browser/playwrightSession");

describeBrowser("existing Chrome through Playwright MCP", () => {
  test("reuses authenticated tabs, performs form actions, captures vision and disconnects without closing Chrome", async () => {
    const { chromium } = require("playwright");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-chrome-smoke-"));
    const profile = path.join(root, "profile");
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(req.headers.cookie?.includes("test-session=authenticated")
        ? '<title>Authenticated fixture</title><h1>Signed in</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><p id="result"></p>'
        : "<h1>Not signed in</h1>");
    });
    let chrome;
    let connected;
    try {
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${server.address().port}`;
      chrome = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, args: ["--remote-debugging-port=0"] });
      await chrome.addCookies([{ name: "test-session", value: "authenticated", url }]);
      const page = chrome.pages()[0];
      await page.goto(url);
      const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
      connected = createBrowserSessions({ env: { UFOO_BROWSER_CDP_ENDPOINT: `http://127.0.0.1:${port}` } });
      const ctx = { workspaceRoot: root, sessionId: "smoke" };
      const invoke = async (tool, args = {}) => {
        const result = await connected.execute({ operation: "call", tool, arguments: args }, ctx);
        expect(result).toMatchObject({ ok: true });
        return result;
      };
      const initial = await connected.execute({ operation: "connect" }, ctx);
      expect(initial).toMatchObject({ ok: true });
      expect(initial.text).toContain("Authenticated fixture");
      expect((await invoke("browser_snapshot")).text).toContain("Signed in");
      await invoke("browser_type", { target: "#name", text: "ucode" });
      await invoke("browser_click", { target: "#save" });
      expect((await invoke("browser_snapshot")).text).toContain("Saved ucode");
      const screenshot = await invoke("browser_take_screenshot", { scale: "css" });
      expect(screenshot.mediaType).toBe("image/png");
      expect(fs.statSync(screenshot.path).size).toBeGreaterThan(100);
      expect(screenshot.base64.length).toBeGreaterThan(100);
      await invoke("browser_type", { target: "#name", text: "canvas mode" });
      const button = await page.locator("#save").boundingBox();
      await invoke("browser_mouse_click_xy", { x: button.x + button.width / 2, y: button.y + button.height / 2 });
      expect(await page.locator("#result").textContent()).toBe("Saved canvas mode");
      const conflict = await connected.execute({ operation: "connect" }, { ...ctx, sessionId: "competing" });
      expect(conflict).toMatchObject({ code: "browser_busy" });
      await connected.disconnect(ctx);
      expect(await page.title()).toBe("Authenticated fixture");
      expect(await page.locator("#result").textContent()).toBe("Saved canvas mode");
    } finally {
      await connected?.closeAll();
      await chrome?.close();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90000);
});
