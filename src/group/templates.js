"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const TEMPLATE_SOURCE = {
  BUILTIN: "builtin",
  GLOBAL: "global",
  PROJECT: "project",
  PATH: "path",
};

const SOURCE_PRIORITY = [
  TEMPLATE_SOURCE.BUILTIN,
  TEMPLATE_SOURCE.GLOBAL,
  TEMPLATE_SOURCE.PROJECT,
];

function defaultBuiltinTemplatesDir() {
  return path.join(path.resolve(__dirname, "..", ".."), "templates", "groups");
}

function defaultGlobalTemplatesDir() {
  return path.join(os.homedir(), ".ufoo", "templates", "groups");
}

function defaultProjectTemplatesDir(projectRoot) {
  return path.join(projectRoot, ".ufoo", "templates", "groups");
}

function getTemplateDirs(projectRoot, options = {}) {
  return {
    builtinDir: options.builtinDir || defaultBuiltinTemplatesDir(),
    globalDir: options.globalDir || defaultGlobalTemplatesDir(),
    projectDir: options.projectDir || defaultProjectTemplatesDir(projectRoot),
  };
}

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isTemplateJsonFile(fileName = "") {
  return String(fileName || "").toLowerCase().endsWith(".json");
}

function templateAliasFromData(data, fallbackAlias) {
  const alias = asTrimmedString(data && data.template && data.template.alias);
  return alias || fallbackAlias;
}

function parseTemplateFile(filePath, source) {
  const baseName = path.basename(filePath, path.extname(filePath));
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      entry: null,
      error: {
        source,
        filePath,
        error: err.message || String(err),
      },
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      entry: null,
      error: {
        source,
        filePath,
        error: `invalid JSON: ${err.message || String(err)}`,
      },
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      entry: null,
      error: {
        source,
        filePath,
        error: "template file must contain a JSON object",
      },
    };
  }

  const alias = templateAliasFromData(data, baseName);
  const templateInfo = data.template && typeof data.template === "object" ? data.template : {};
  const entry = {
    alias,
    source,
    filePath,
    data,
    templateId: asTrimmedString(templateInfo.id),
    templateName: asTrimmedString(templateInfo.name),
    templateDescription: asTrimmedString(templateInfo.description || templateInfo.summary),
    schemaVersion: Number.isInteger(data.schema_version) ? data.schema_version : null,
  };
  return { entry, error: null };
}

function formatTemplateLoadErrors(errors = []) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return errors
    .map((item) => `${item.filePath}: ${item.error}`)
    .join("; ");
}

function loadTemplatesFromDir(dirPath, source) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return { entries: [], errors: [] };
  }

  const entries = [];
  const errors = [];
  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isTemplateJsonFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  for (const fileName of files) {
    const filePath = path.join(dirPath, fileName);
    const parsed = parseTemplateFile(filePath, source);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    entries.push(parsed.entry);
  }

  return { entries, errors };
}

function loadTemplateRegistry(projectRoot, options = {}) {
  const dirs = getTemplateDirs(projectRoot, options);
  const dirBySource = {
    [TEMPLATE_SOURCE.BUILTIN]: dirs.builtinDir,
    [TEMPLATE_SOURCE.GLOBAL]: dirs.globalDir,
    [TEMPLATE_SOURCE.PROJECT]: dirs.projectDir,
  };

  const byAlias = new Map();
  const errors = [];

  for (const source of SOURCE_PRIORITY) {
    const dirPath = dirBySource[source];
    const loaded = loadTemplatesFromDir(dirPath, source);
    errors.push(...loaded.errors);
    for (const entry of loaded.entries) {
      byAlias.set(entry.alias, entry);
    }
  }

  const templates = Array.from(byAlias.values())
    .sort((a, b) => a.alias.localeCompare(b.alias, "en", { sensitivity: "base" }));

  return { templates, byAlias, errors, dirs };
}

function isLikelyPathReference(reference = "") {
  const value = String(reference || "").trim();
  if (!value) return false;
  return value.includes("/") || value.includes("\\") || value.endsWith(".json") || value.startsWith(".");
}

function resolveTemplateReference(projectRoot, reference, options = {}) {
  const value = asTrimmedString(reference);
  if (!value) {
    return { entry: null, errors: [] };
  }

  const cwd = options.cwd || process.cwd();
  const allowPath = options.allowPath !== false;

  if (allowPath && isLikelyPathReference(value)) {
    const candidates = [];
    if (path.isAbsolute(value)) {
      candidates.push(value);
    } else {
      candidates.push(path.resolve(cwd, value));
      const fallback = path.resolve(projectRoot, value);
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const parsed = parseTemplateFile(candidate, TEMPLATE_SOURCE.PATH);
      return {
        entry: parsed.entry,
        errors: parsed.error ? [parsed.error] : [],
      };
    }
  }

  const registry = loadTemplateRegistry(projectRoot, options);
  return {
    entry: registry.byAlias.get(value) || null,
    errors: registry.errors,
  };
}

function normalizeTemplateAlias(alias = "") {
  const value = asTrimmedString(alias);
  if (!value) return "";
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  return valid ? value : "";
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTemplateFromBuiltin(projectRoot, alias, fromAlias, options = {}) {
  const nextAlias = normalizeTemplateAlias(alias);
  if (!nextAlias) {
    throw new Error("alias must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/");
  }

  const sourceAlias = asTrimmedString(fromAlias);
  if (!sourceAlias) {
    throw new Error("from alias is required");
  }

  const dirs = getTemplateDirs(projectRoot, options);
  const builtinLoaded = loadTemplatesFromDir(dirs.builtinDir, TEMPLATE_SOURCE.BUILTIN);
  const sourceTemplate = builtinLoaded.entries.find((entry) => entry.alias === sourceAlias);
  if (!sourceTemplate) {
    const details = formatTemplateLoadErrors(builtinLoaded.errors);
    if (details) {
      throw new Error(`builtin template not found: ${sourceAlias}; failed to load builtin templates: ${details}`);
    }
    throw new Error(`builtin template not found: ${sourceAlias}`);
  }

  const targetScope = options.scope === "global" ? "global" : "project";
  const targetDir = targetScope === "global" ? dirs.globalDir : dirs.projectDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, `${nextAlias}.json`);
  if (fs.existsSync(targetPath) && !options.force) {
    throw new Error(`template already exists: ${targetPath} (use --force to overwrite)`);
  }

  const nextData = deepClone(sourceTemplate.data);
  nextData.template = nextData.template && typeof nextData.template === "object"
    ? nextData.template
    : {};
  nextData.template.alias = nextAlias;
  if (!asTrimmedString(nextData.template.id)) nextData.template.id = nextAlias;
  if (!asTrimmedString(nextData.template.name)) nextData.template.name = nextAlias;

  fs.writeFileSync(targetPath, `${JSON.stringify(nextData, null, 2)}\n`, "utf8");

  return {
    alias: nextAlias,
    from: sourceAlias,
    scope: targetScope,
    filePath: targetPath,
  };
}

module.exports = {
  TEMPLATE_SOURCE,
  defaultBuiltinTemplatesDir,
  defaultGlobalTemplatesDir,
  defaultProjectTemplatesDir,
  getTemplateDirs,
  loadTemplateRegistry,
  resolveTemplateReference,
  createTemplateFromBuiltin,
  normalizeTemplateAlias,
};
