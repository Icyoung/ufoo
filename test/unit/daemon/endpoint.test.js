"use strict";

const fs = require("fs");
const path = require("path");

const {
  resolveDaemonEndpoint,
  routeDaemonRequest,
} = require("../../../src/runtime/daemon/endpoint");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

describe("daemon endpoint routing", () => {
  test("routes global topology through the controller socket with project identity", () => {
    const controllerRoot = fs.mkdtempSync("/tmp/ufoo-ep-c-");
    const projectRoot = fs.mkdtempSync("/tmp/ufoo-ep-p-");
    try {
      const endpoint = resolveDaemonEndpoint(projectRoot, {
        controllerRoot,
        topology: "global",
      });
      expect(endpoint).toMatchObject({
        topology: "global",
        scope: "global",
        socketPath: getUfooPaths(fs.realpathSync(controllerRoot)).ufooSock,
        routeProjectRoot: fs.realpathSync(projectRoot),
      });
      expect(routeDaemonRequest(endpoint, { type: "status" })).toEqual({
        type: "status",
        project_root: fs.realpathSync(projectRoot),
      });
    } finally {
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("hybrid prefers a compatibility socket but falls back to global", async () => {
    const controllerRoot = fs.mkdtempSync("/tmp/ufoo-ep-c-");
    const projectRoot = fs.mkdtempSync("/tmp/ufoo-ep-p-");
    const projectSocket = getUfooPaths(fs.realpathSync(projectRoot)).ufooSock;
    try {
      expect(resolveDaemonEndpoint(projectRoot, {
        controllerRoot,
        topology: "hybrid",
      })).toMatchObject({
        scope: "global",
        socketPath: getUfooPaths(fs.realpathSync(controllerRoot)).ufooSock,
      });

      fs.mkdirSync(path.dirname(projectSocket), { recursive: true });
      const net = require("net");
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(projectSocket, () => {
          try {
            expect(resolveDaemonEndpoint(projectRoot, {
              controllerRoot,
              topology: "hybrid",
            })).toMatchObject({
              scope: "project",
              socketPath: projectSocket,
              routeProjectRoot: "",
            });
            server.close(resolve);
          } catch (err) {
            server.close(() => reject(err));
          }
        });
      });
    } finally {
      if (fs.existsSync(projectSocket)) fs.unlinkSync(projectSocket);
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
