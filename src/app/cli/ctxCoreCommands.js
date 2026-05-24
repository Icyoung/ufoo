"use strict";

const path = require("path");

function createUnknownCtxError(subcmd) {
  const err = new Error(`Unknown ctx subcommand: ${subcmd}`);
  err.code = "UFOO_CTX_UNKNOWN";
  return err;
}

async function runCtxCommand(subcmd = "doctor", subargs = [], options = {}) {
  const {
    cwd = process.cwd(),
    allowIndexNew = true,
    updateDecisionIndexPaths = true,
  } = options;

  const DecisionsManager = require("../../coordination/context/decisions");
  const ContextDoctor = require("../../coordination/context/doctor");
  const SyncManager = require("../../coordination/context/sync");

  switch (subcmd) {
    case "doctor": {
      const doctor = new ContextDoctor(cwd);
      const mode = subargs.includes("--project") ? "project" : "protocol";
      const projectPath = mode === "project" ? subargs[subargs.indexOf("--project") + 1] : null;
      await doctor.run({ mode, projectPath });
      return;
    }
    case "lint": {
      const doctor = new ContextDoctor(cwd);
      const mode = subargs.includes("--project") ? "project" : "protocol";
      const projectPath = mode === "project" ? subargs[subargs.indexOf("--project") + 1] : null;
      if (mode === "project") {
        doctor.lintProject(projectPath);
      } else {
        doctor.lintProtocol();
      }
      return;
    }
    case "decisions": {
      const manager = new DecisionsManager(cwd);
      const opts = {};

      if (allowIndexNew) {
        if (subargs[0] === "index" || subargs.includes("--index")) {
          manager.writeIndex();
          return;
        }
        if (subargs[0] === "new") {
          const create = { title: "", author: "", status: "", nickname: "" };
          for (let i = 1; i < subargs.length; i++) {
            const arg = subargs[i];
            if (arg === "--author") {
              create.author = subargs[++i] || "";
              continue;
            }
            if (arg === "--status") {
              create.status = subargs[++i] || "";
              continue;
            }
            if (arg === "--nickname") {
              create.nickname = subargs[++i] || "";
              continue;
            }
            if (!arg.startsWith("-")) {
              create.title = create.title ? `${create.title} ${arg}` : arg;
            }
          }
          manager.createDecision(create);
          return;
        }
      }

      for (let i = 0; i < subargs.length; i++) {
        if (subargs[i] === "-n") opts.num = parseInt(subargs[++i]);
        if (subargs[i] === "-s") opts.status = subargs[++i];
        if (subargs[i] === "-l") opts.listOnly = true;
        if (subargs[i] === "-a") opts.all = true;
        if (subargs[i] === "-d") {
          manager.decisionsDir = subargs[++i];
          if (updateDecisionIndexPaths) {
            manager.contextDir = path.dirname(manager.decisionsDir);
            manager.indexFile = path.join(manager.contextDir, "decisions.jsonl");
          }
        }
        if (subargs[i] === "--nickname") opts.nickname = subargs[++i];
      }

      if (opts.listOnly) {
        manager.list({ status: opts.status || "open" });
      } else {
        manager.show({
          status: opts.status || "open",
          num: opts.num || 1,
          all: opts.all || false,
        });
      }
      return;
    }
    case "sync": {
      const manager = new SyncManager(cwd);
      const action = (subargs[0] || "list").toLowerCase();

      if (action === "write" || action === "new" || action === "add") {
        const create = {
          message: "",
          from: "",
          for: "",
          decision: "",
          file: "",
          tests: "",
          verification: "",
          risk: "",
          next: "",
        };

        for (let i = 1; i < subargs.length; i++) {
          const arg = subargs[i];
          if (arg === "--from") {
            create.from = subargs[++i] || "";
            continue;
          }
          if (arg === "--for") {
            create.for = subargs[++i] || "";
            continue;
          }
          if (arg === "--decision") {
            create.decision = subargs[++i] || "";
            continue;
          }
          if (arg === "--file") {
            create.file = subargs[++i] || "";
            continue;
          }
          if (arg === "--tests") {
            create.tests = subargs[++i] || "";
            continue;
          }
          if (arg === "--verification") {
            create.verification = subargs[++i] || "";
            continue;
          }
          if (arg === "--risk") {
            create.risk = subargs[++i] || "";
            continue;
          }
          if (arg === "--next") {
            create.next = subargs[++i] || "";
            continue;
          }
          if (!arg.startsWith("-")) {
            create.message = create.message ? `${create.message} ${arg}` : arg;
          }
        }

        manager.write(create);
        return;
      }

      if (action === "list" || action === "show" || action === "-l") {
        const opts = {
          num: 20,
          for: "",
          from: "",
        };

        for (let i = 1; i < subargs.length; i++) {
          const arg = subargs[i];
          if (arg === "-n" || arg === "--num") {
            opts.num = parseInt(subargs[++i], 10);
            continue;
          }
          if (arg === "--for") {
            opts.for = subargs[++i] || "";
            continue;
          }
          if (arg === "--from") {
            opts.from = subargs[++i] || "";
          }
        }

        manager.list(opts);
        return;
      }

      throw new Error(
        `Unknown ctx sync action: ${action}. Use 'list' or 'write'.`
      );
    }
    default:
      throw createUnknownCtxError(subcmd);
  }
}

module.exports = {
  runCtxCommand,
  createUnknownCtxError,
};
