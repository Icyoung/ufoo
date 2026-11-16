"use strict";

// A detached supervisor persists the real shell outcome even if its agent host
// exits. It shares the command's process group so explicit stop still kills both.
const fs = require("fs");
const { spawn } = require("child_process");
const [recordPath, command] = process.argv.slice(2);
let finished = false;
function finish(code, signal, error) {
  if (finished) return;
  finished = true;
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const temporary = `${recordPath}.${process.pid}.exit.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...record, status: record.status === "stopped" ? "stopped" : "exited",
      exitCode: code, signal: signal || "", ...(error ? { error } : {}), endedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(temporary, recordPath);
  } catch { /* Parent can still report an unknown outcome from liveness. */ }
  process.exitCode = typeof code === "number" ? code : 1;
}
const child = spawn(command, { shell: true, stdio: "inherit", windowsHide: true });
child.once("error", error => finish(-1, "", error.message));
child.once("exit", (code, signal) => finish(code, signal));
