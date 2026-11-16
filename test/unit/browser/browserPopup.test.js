"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const popupDir = path.resolve(__dirname, "../../../extensions/ufoo-browser");

function harness(initial) {
  const all = [];
  const make = (tag = "div") => {
    const node = { tag, textContent: "", hidden: false, disabled: false, dataset: {}, children: [], events: {}, attributes: {},
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, fn) { this.events[name] = fn; }, contains() { return false; }, focus() {},
      querySelectorAll() { return this.children.flatMap(child => [child, ...child.children]).filter(child => child.tag === "button"); },
    };
    all.push(node); return node;
  };
  const nodes = Object.fromEntries([...fs.readFileSync(path.join(popupDir, "popup.html"), "utf8").matchAll(/id="([^"]+)"/g)].map(match => [match[1], make()]));
  nodes["toggle-pause"].tag = nodes.reconnect.tag = "button";
  const panel = make(); const connection = make();
  const document = { getElementById: id => nodes[id], createElement: make,
    querySelector: selector => selector === ".panel" ? panel : connection,
    querySelectorAll: () => all.filter(node => node.tag === "button"), activeElement: null,
  };
  let state = initial;
  const chrome = { runtime: { getManifest: () => ({ version: "0.1.0" }), sendMessage: jest.fn((message, done) => {
    if (message.type === "ufoo.pauseAll") state = { ...state, connectionState: "paused", paused: true, tabOwners: [] };
    if (message.type === "ufoo.resumeAll") state = { ...state, connectionState: "connected", paused: false };
    if (message.type === "ufoo.releaseTab") state = { ...state, tabOwners: state.tabOwners.filter(item => item.tabId !== message.tabId) };
    done({ ok: true, ...state });
  }) }, storage: { onChanged: { addListener: jest.fn() } } };
  const context = vm.createContext({ document, chrome, URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(popupDir, "popup.js"), "utf8"), context);
  return { nodes, chrome, context, click: node => node.events.click(), flush: () => new Promise(resolve => setImmediate(resolve)) };
}

const connected = { connectionState: "connected", paused: false, tabOwners: [{ tabId: 17, projectName: "demo", agentName: "builder", title: "<b>Page title</b>", url: "http://localhost:5173/page" }] };

test("popup releases the explicit tab and toggles pause/resume through the existing protocol", async () => {
  const ui = harness(connected); await ui.flush();
  const row = ui.nodes["tab-list"].children[0];
  expect(row.children[1].children[1].textContent).toBe("<b>Page title</b>");
  expect(row.children[1].children[2].textContent).toBe("localhost:5173/page");
  await ui.click(row.children[2]);
  expect(ui.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "ufoo.releaseTab", tabId: 17 }, expect.any(Function));
  expect(ui.nodes["empty-tabs"].hidden).toBe(false);
  await ui.click(ui.nodes["toggle-pause"]);
  expect(ui.nodes["status-title"].textContent).toBe("浏览器控制已暂停");
  await ui.click(ui.nodes["toggle-pause"]);
  expect(ui.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "ufoo.resumeAll" }, expect.any(Function));
  expect(ui.nodes["status-title"].textContent).toBe("浏览器已就绪");
});

test("failed actions surface runtime errors and unlock controls; repeated pending clicks do not resend", async () => {
  const ui = harness({ connectionState: "waiting_for_ufoo", tabOwners: [] }); await ui.flush();
  let respond;
  ui.chrome.runtime.sendMessage.mockImplementationOnce((_msg, done) => { respond = done; });
  const first = ui.click(ui.nodes.reconnect);
  expect(ui.nodes.reconnect.disabled).toBe(true);
  const calls = ui.chrome.runtime.sendMessage.mock.calls.length;
  await ui.click(ui.nodes.reconnect);
  expect(ui.chrome.runtime.sendMessage.mock.calls.length).toBe(calls);
  ui.chrome.runtime.lastError = { message: "Native host disconnected" };
  respond();
  await first;
  expect(ui.nodes["action-error"].textContent).toBe("Native host disconnected");
  expect(ui.nodes["action-error"].hidden).toBe(false);
  expect(ui.nodes.reconnect.disabled).toBe(false);
});

test("storage updates distinguish paused, install and disabled states without rendering technical errors as HTML", async () => {
  const ui = harness(connected); await ui.flush();
  const notify = ui.chrome.storage.onChanged.addListener.mock.calls[0][0];
  notify({ ufooBrowserState: { newValue: { connectionState: "native_not_installed", error: "<script>bad</script>" } } }, "local");
  expect(ui.nodes["connection-help"].hidden).toBe(false);
  expect(ui.nodes["help-command"].textContent).toBe("ufoo browser install");
  expect(ui.nodes["connection-error"].textContent).toBe("<script>bad</script>");
  expect(ui.nodes["toggle-pause"].hidden).toBe(true);
  notify({ ufooBrowserState: { newValue: { connectionState: "disabled" } } }, "local");
  expect(ui.nodes["help-command"].textContent).toBe("ufoo browser enable");
  notify({ ufooBrowserState: { newValue: { connectionState: "connected", paused: true } } }, "local");
  expect(ui.nodes["toggle-pause"].textContent).toBe("恢复浏览器控制");
  expect(ui.nodes.reconnect.hidden).toBe(true);
});
