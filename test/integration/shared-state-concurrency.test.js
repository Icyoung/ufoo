const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { loadAgentsData } = require("../../src/coordination/state/agentsStore");
const { withFileLock } = require("../../src/coordination/state/fileLock");

function run(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code, ...args], { cwd: path.resolve(__dirname, "../..") });
    let errors = "";
    child.stderr.on("data", (data) => { errors += data; });
    child.once("error", reject);
    child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(errors || `exit ${status}`)));
  });
}

describe("shared state across real Node processes", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-concurrency-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test("concurrent producers and consumer retain every message exactly once", async () => {
    const file = path.join(root, "pending.jsonl");
    const output = path.join(root, "received.jsonl");
    const consumer = run(`
      const fs = require('fs');
      const { DeliveryQueue } = require('./src/coordination/bus/deliveryQueue');
      const q = new DeliveryQueue(process.argv[1]);
      const deadline = Date.now() + 15000;
      let count = 0;
      while (count < 300 && Date.now() < deadline) {
        const claim = q.claimNext();
        if (claim) { fs.appendFileSync(process.argv[2], claim.event.seq + '\\n'); q.completeClaim(claim); count++; }
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      if (count !== 300) throw new Error('lost messages: ' + count);
    `, [file, output]);
    const producers = [0, 100, 200].map((offset) => run(`
      const { DeliveryQueue } = require('./src/coordination/bus/deliveryQueue');
      const q = new DeliveryQueue(process.argv[1]);
      for (let i = 1; i <= 100; i++) q.append({ seq: Number(process.argv[2]) + i, event: 'message' });
    `, [file, String(offset)]));
    await Promise.all([consumer, ...producers]);
    const received = fs.readFileSync(output, "utf8").trim().split("\n").map(Number).sort((a, b) => a - b);
    expect(received).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  }, 20000);

  test("registrations, heartbeats and native metadata survive concurrent writers", async () => {
    const file = path.join(root, "all-agents.json");
    await Promise.all([0, 1, 2, 3].map((id) => run(`
      const { loadAgentsData, saveAgentsData, updateAgentsData } = require('./src/coordination/state/agentsStore');
      const file = process.argv[1], id = process.argv[2];
      const snapshot = loadAgentsData(file);
      snapshot.agents[id] = { status: 'active', native_delivery_ready: true };
      saveAgentsData(file, snapshot);
      for (let i = 0; i < 40; i++) updateAgentsData(file, data => { data.agents[id].last_seen = i; });
    `, [file, String(id)])));
    const agents = loadAgentsData(file).agents;
    expect(Object.keys(agents).sort()).toEqual(["0", "1", "2", "3"]);
    for (const meta of Object.values(agents)) expect(meta).toMatchObject({ last_seen: 39, native_delivery_ready: true });
  });

  test("expired crash locks recover, and exceptions release the lock", () => {
    const file = path.join(root, "state.json");
    fs.mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(() => withFileLock(file, () => { throw new Error("failure"); })).toThrow("failure");
    expect(withFileLock(file, () => "recovered")).toBe("recovered");
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});
