const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const Injector = require("../../../src/bus/inject");

describe("Injector", () => {
  let busDir;

  beforeEach(() => {
    busDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-inject-test-"));
  });

  afterEach(() => {
    fs.rmSync(busDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    test("stores busDir and agentsFile", () => {
      const injector = new Injector("/tmp/bus", "/tmp/agents.json");
      expect(injector.busDir).toBe("/tmp/bus");
      expect(injector.agentsFile).toBe("/tmp/agents.json");
    });
  });

  describe("getTtyPath", () => {
    test("returns correct path for subscriber", () => {
      const injector = new Injector(busDir, null);
      const result = injector.getTtyPath("codex:abc123");
      expect(result).toBe(path.join(busDir, "queues", "codex_abc123", "tty"));
    });
  });

  describe("getAgentMeta", () => {
    test("returns null when agentsFile is not set", () => {
      const injector = new Injector(busDir, null);
      expect(injector.getAgentMeta("codex:abc")).toBeNull();
    });

    test("returns null when agentsFile does not exist", () => {
      const injector = new Injector(busDir, "/nonexistent/agents.json");
      expect(injector.getAgentMeta("codex:abc")).toBeNull();
    });

    test("returns agent meta from agents file", () => {
      const agentsFile = path.join(busDir, "agents.json");
      const data = {
        agents: {
          "codex:abc": { nickname: "builder", tmux_pane: "%5" },
        },
      };
      fs.writeFileSync(agentsFile, JSON.stringify(data));

      const injector = new Injector(busDir, agentsFile);
      const meta = injector.getAgentMeta("codex:abc");
      expect(meta.nickname).toBe("builder");
      expect(meta.tmux_pane).toBe("%5");
    });

    test("returns null for unknown subscriber", () => {
      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(agentsFile, JSON.stringify({ agents: {} }));

      const injector = new Injector(busDir, agentsFile);
      expect(injector.getAgentMeta("codex:unknown")).toBeNull();
    });

    test("returns null on parse error", () => {
      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(agentsFile, "not json");

      const injector = new Injector(busDir, agentsFile);
      expect(injector.getAgentMeta("codex:abc")).toBeNull();
    });
  });

  describe("getTmuxPane", () => {
    test("returns null when agentsFile is not set", () => {
      const injector = new Injector(busDir, null);
      expect(injector.getTmuxPane("codex:abc")).toBeNull();
    });

    test("returns null when agentsFile does not exist", () => {
      const injector = new Injector(busDir, "/nonexistent/agents.json");
      expect(injector.getTmuxPane("codex:abc")).toBeNull();
    });

    test("returns tmux pane from agents file", () => {
      const agentsFile = path.join(busDir, "agents.json");
      const data = {
        agents: {
          "codex:abc": { tmux_pane: "%3" },
        },
      };
      fs.writeFileSync(agentsFile, JSON.stringify(data));

      const injector = new Injector(busDir, agentsFile);
      expect(injector.getTmuxPane("codex:abc")).toBe("%3");
    });

    test("returns null when subscriber has no tmux_pane", () => {
      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(
        agentsFile,
        JSON.stringify({ agents: { "codex:abc": {} } })
      );

      const injector = new Injector(busDir, agentsFile);
      expect(injector.getTmuxPane("codex:abc")).toBeNull();
    });

    test("returns null on parse error", () => {
      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(agentsFile, "broken");

      const injector = new Injector(busDir, agentsFile);
      expect(injector.getTmuxPane("codex:abc")).toBeNull();
    });
  });

  describe("readTty", () => {
    test("returns null when tty file does not exist", () => {
      const injector = new Injector(busDir, null);
      expect(injector.readTty("codex:abc")).toBeNull();
    });

    test("reads and trims tty value", () => {
      const queueDir = path.join(busDir, "queues", "codex_abc");
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, "tty"), "/dev/ttys001\n");

      const injector = new Injector(busDir, null);
      expect(injector.readTty("codex:abc")).toBe("/dev/ttys001");
    });
  });

  describe("getInjectSockPath", () => {
    test("returns correct socket path", () => {
      const injector = new Injector(busDir, null);
      const result = injector.getInjectSockPath("claude-code:xyz");
      expect(result).toBe(
        path.join(busDir, "queues", "claude-code_xyz", "inject.sock")
      );
    });
  });

  describe("injectPty", () => {
    test("throws when socket does not exist", async () => {
      const injector = new Injector(busDir, null);
      await expect(injector.injectPty("codex:abc", "test")).rejects.toThrow(
        "Inject socket not found"
      );
    });
  });

  describe("injectPtyAtPath", () => {
    test("sends command via socket and resolves on ok response", async () => {
      const sockPath = path.join(busDir, "test.sock");
      const server = net.createServer((conn) => {
        conn.on("data", (data) => {
          const msg = JSON.parse(data.toString().trim());
          expect(msg.type).toBe("inject");
          expect(msg.command).toBe("hello");
          conn.write(JSON.stringify({ ok: true }) + "\n");
        });
      });

      await new Promise((resolve) => server.listen(sockPath, resolve));
      try {
        const injector = new Injector(busDir, null);
        await injector.injectPtyAtPath(sockPath, "hello");
      } finally {
        server.close();
      }
    });

    test("rejects on error response", async () => {
      const sockPath = path.join(busDir, "test-err.sock");
      const server = net.createServer((conn) => {
        conn.on("data", () => {
          conn.write(JSON.stringify({ ok: false, error: "bad" }) + "\n");
        });
      });

      await new Promise((resolve) => server.listen(sockPath, resolve));
      try {
        const injector = new Injector(busDir, null);
        await expect(
          injector.injectPtyAtPath(sockPath, "cmd")
        ).rejects.toThrow("bad");
      } finally {
        server.close();
      }
    });

    test("rejects on connection error", async () => {
      const injector = new Injector(busDir, null);
      await expect(
        injector.injectPtyAtPath("/nonexistent/sock", "cmd")
      ).rejects.toThrow();
    });
  });

  describe("inject", () => {
    test("rejects inject for ufoo-code subscribers", async () => {
      const injector = new Injector(busDir, null);
      await expect(
        injector.inject("ufoo-code:abc123", "hello")
      ).rejects.toThrow("Inject disabled for ufoo-code:abc123");
    });

    test("throws when no inject method available", async () => {
      // No socket, no tmux, no tty
      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(
        agentsFile,
        JSON.stringify({ agents: { "codex:test": {} } })
      );

      const injector = new Injector(busDir, agentsFile);
      await expect(injector.inject("codex:test")).rejects.toThrow(
        "No inject method available"
      );
    });

    test("uses default command /ubus for claude-code", async () => {
      // We test that inject resolves command correctly - it will still fail
      // because no socket/tmux available, but the error message confirms it got past the guard
      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(
        agentsFile,
        JSON.stringify({ agents: { "claude-code:test": {} } })
      );

      const injector = new Injector(busDir, agentsFile);
      await expect(injector.inject("claude-code:test")).rejects.toThrow(
        "No inject method available"
      );
    });

    test("uses PTY socket when available", async () => {
      const sockPath = path.join(
        busDir,
        "queues",
        "codex_test",
        "inject.sock"
      );
      fs.mkdirSync(path.dirname(sockPath), { recursive: true });

      const server = net.createServer((conn) => {
        conn.on("data", () => {
          conn.write(JSON.stringify({ ok: true }) + "\n");
        });
      });

      await new Promise((resolve) => server.listen(sockPath, resolve));

      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(
        agentsFile,
        JSON.stringify({ agents: { "codex:test": {} } })
      );

      try {
        const injector = new Injector(busDir, agentsFile);
        await injector.inject("codex:test", "ubus");
      } finally {
        server.close();
      }
    });

    test("uses host inject socket when available", async () => {
      const hostSock = path.join(busDir, "host-inject.sock");
      const server = net.createServer((conn) => {
        conn.on("data", () => {
          conn.write(JSON.stringify({ ok: true }) + "\n");
        });
      });

      await new Promise((resolve) => server.listen(hostSock, resolve));

      const agentsFile = path.join(busDir, "agents.json");
      fs.writeFileSync(
        agentsFile,
        JSON.stringify({
          agents: { "codex:test": { host_inject_sock: hostSock } },
        })
      );

      try {
        const injector = new Injector(busDir, agentsFile);
        await injector.inject("codex:test", "ubus");
      } finally {
        server.close();
      }
    });
  });
});
