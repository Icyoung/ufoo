"use strict";

const path = require("path");
const {
  loadTemplateRegistry,
  resolveTemplateReference,
  createTemplateFromBuiltin,
} = require("../group/templates");
const { validateTemplateTarget } = require("../group/templateValidation");

function parseTemplateNewArgs(args = []) {
  const alias = String(args[0] || "").trim();
  const options = {
    from: "",
    scope: "project",
    force: false,
  };
  let sawGlobal = false;
  let sawProject = false;

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--from") {
      options.from = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--global") {
      sawGlobal = true;
      options.scope = "global";
      continue;
    }
    if (token === "--project") {
      sawProject = true;
      options.scope = "project";
      continue;
    }
    if (token === "--force") {
      options.force = true;
      continue;
    }
    if (token === "--json") {
      continue;
    }
    throw new Error(`Unknown option for template new: ${token}`);
  }

  if (!alias) throw new Error("template new requires <alias>");
  if (!options.from) throw new Error("template new requires --from <builtin-alias>");
  if (sawGlobal && sawProject) {
    throw new Error("template new cannot use both --global and --project");
  }

  return { alias, ...options };
}

function formatDisplayPath(filePath = "", cwd = "") {
  const target = String(filePath || "");
  if (!target) return "";
  const base = String(cwd || "").trim();
  if (!base) return target;
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..")) return target;
  return relative;
}

function printList({ templates, errors }, { write, json, cwd }) {
  if (json) {
    write(JSON.stringify({ templates, errors }, null, 2));
    return;
  }

  if (!templates.length) {
    write("No group templates found.");
  } else {
    for (const item of templates) {
      const nameLabel = item.templateName || item.alias;
      const idLabel = item.templateId || "-";
      const verLabel = Number.isInteger(item.schemaVersion) ? item.schemaVersion : "-";
      const displayPath = formatDisplayPath(item.filePath, cwd);
      write(`- ${item.alias} [${item.source}]`);
      write(`  name: ${nameLabel}`);
      write(`  id: ${idLabel}  schema: ${verLabel}`);
      write(`  file: ${displayPath}`);
    }
  }

  if (errors.length > 0) {
    write(`Warnings: ${errors.length} template file(s) failed to load`);
    for (const err of errors) {
      const displayPath = formatDisplayPath(err.filePath, cwd);
      write(`  - ${displayPath}: ${err.error}`);
    }
  }
}

function formatResolveErrors(errors = []) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return errors
    .map((item) => `${item.filePath}: ${item.error || item.message || "unknown error"}`)
    .join("; ");
}

function throwResolveFailure(target, resolved = {}) {
  const details = formatResolveErrors(resolved.errors || []);
  if (details) throw new Error(`Failed to load template "${target}": ${details}`);
  throw new Error(`Template not found: ${target}`);
}

function printValidation(result, target, entry, { write, json }) {
  if (json) {
    write(
      JSON.stringify(
        {
          target,
          alias: entry.alias,
          source: entry.source,
          filePath: entry.filePath,
          ok: result.ok,
          errors: result.errors,
          prompt_profiles: result.promptProfiles || [],
        },
        null,
        2
      )
    );
    return;
  }

  if (result.ok) {
    write(`✓ Template "${entry.alias}" is valid (${entry.source})`);
    if (Array.isArray(result.promptProfiles) && result.promptProfiles.length > 0) {
      for (const profile of result.promptProfiles) {
        write(
          `  - ${profile.nickname || profile.agent_id || "agent"}: `
          + `${profile.requested_profile} -> ${profile.resolved_profile} `
          + `[${profile.profile_source}]`
        );
      }
    }
    return;
  }

  write(`✗ Template "${entry.alias}" is invalid (${result.errors.length} error(s))`);
  for (const err of result.errors) {
    write(`  - ${err.path}: ${err.message}`);
  }
}

async function runGroupCoreCommand(subcmd, cmdArgs = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  const write = typeof options.write === "function" ? options.write : console.log;
  const json = Boolean(options.json);
  const templatesOptions = options.templatesOptions || {};
  const promptProfilesOptions = options.promptProfilesOptions || {};

  const args = Array.isArray(cmdArgs) ? cmdArgs.filter((item) => item !== undefined) : [];
  const normalizedSubcmd = String(subcmd || "").trim().toLowerCase();

  if (normalizedSubcmd === "templates") {
    const action = String(args[0] || "list").trim().toLowerCase();
    if (action !== "list" && action !== "ls") {
      throw new Error(`Unknown group templates action: ${action}`);
    }

    const registry = loadTemplateRegistry(cwd, templatesOptions);
    const templates = registry.templates.map((item) => ({
      alias: item.alias,
      source: item.source,
      filePath: item.filePath,
      templateId: item.templateId || "",
      templateName: item.templateName || "",
      schemaVersion: item.schemaVersion,
    }));
    printList({ templates, errors: registry.errors }, { write, json, cwd });
    return;
  }

  if (normalizedSubcmd !== "template") {
    throw new Error(`Unknown group subcommand: ${subcmd}`);
  }

  const action = String(args[0] || "list").trim().toLowerCase();

  if (action === "list") {
    const registry = loadTemplateRegistry(cwd, templatesOptions);
    const templates = registry.templates.map((item) => ({
      alias: item.alias,
      source: item.source,
      filePath: item.filePath,
      templateId: item.templateId || "",
      templateName: item.templateName || "",
      schemaVersion: item.schemaVersion,
    }));
    printList({ templates, errors: registry.errors }, { write, json, cwd });
    return;
  }

  if (action === "show") {
    const target = String(args[1] || "").trim();
    if (!target) throw new Error("group template show requires <alias>");
    const resolved = resolveTemplateReference(cwd, target, {
      allowPath: false,
      cwd,
      ...templatesOptions,
    });
    if (!resolved.entry) {
      throwResolveFailure(target, resolved);
    }
    write(JSON.stringify(resolved.entry.data, null, 2));
    return;
  }

  if (action === "validate") {
    const target = String(args[1] || "").trim();
    if (!target) throw new Error("group template validate requires <alias|path>");
    const result = validateTemplateTarget(cwd, target, {
      allowPath: true,
      cwd,
      templatesOptions,
      promptProfilesOptions,
    });
    if (!result.entry) {
      throwResolveFailure(target, { errors: result.errors || [] });
    }
    printValidation(result, target, result.entry, { write, json });
    if (!result.ok) {
      throw new Error(`Template validation failed: ${result.entry.alias}`);
    }
    return;
  }

  if (action === "new") {
    const params = parseTemplateNewArgs(args.slice(1));
    const created = createTemplateFromBuiltin(cwd, params.alias, params.from, {
      ...templatesOptions,
      scope: params.scope,
      force: params.force,
    });

    if (json) {
      write(JSON.stringify(created, null, 2));
      return;
    }
    const relative = path.relative(cwd, created.filePath) || created.filePath;
    write(`Created template "${created.alias}" from "${created.from}" at ${relative}`);
    return;
  }

  throw new Error(`Unknown group template action: ${action}`);
}

module.exports = {
  runGroupCoreCommand,
};
