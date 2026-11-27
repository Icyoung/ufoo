"use strict";

function taskLabel(task = {}) {
  const description = String(task.title || task.objective || "").trim().split(/[。！？\n]/u)[0].trim();
  const letters = Array.from(description);
  const short = letters.length > 36 ? letters.slice(0, 35).join("").trimEnd() + "…" : description;
  return short ? "Task · " + short : "Task";
}

module.exports = { taskLabel };
