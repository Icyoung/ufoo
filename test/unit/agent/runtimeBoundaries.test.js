"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../../..");

function importsFrom(file) {
  return [...fs.readFileSync(file, "utf8").matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
}

describe("shared runtime dependency boundaries", () => {
  test("a runtime entry can load its local dependencies without coding, daemon, capability or UI implementations", () => {
    const pending = [path.join(root, "src/agents/runtime/index.js")];
    const visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      expect(file.replace(root, "")).not.toMatch(/^\/src\/(?:code|app|ui|runtime\/daemon|agents\/capabilities)\//);
      for (const dependency of importsFrom(file)) {
        if (dependency.startsWith(".")) pending.push(require.resolve(path.resolve(path.dirname(file), dependency)));
      }
    }
    expect(visited.size).toBeGreaterThan(10);
  });

  test("provider adapters no longer depend on coding runner or coding transport implementations", () => {
    for (const file of ["runtimeConfig.js", "nativeTransport.js", "upstreamTransport.js"]) {
      expect(importsFrom(path.join(root, "src/agents/providers", file)).filter((dependency) => dependency.includes("/code/"))).toEqual([]);
    }
  });
});
