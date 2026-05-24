"use strict";

const { loadPromptProfileRegistry } = require("./promptProfiles");
const { resolveTemplateReference } = require("./templates");
const { validateTemplate } = require("./validateTemplate");

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function formatResolveErrors(errors = []) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return errors
    .map((item) => `${item.filePath}: ${item.error || item.message || "unknown error"}`)
    .join("; ");
}

function resolveTemplateTarget(projectRoot, target, options = {}) {
  const rawTarget = asTrimmedString(target);
  if (!rawTarget) {
    return {
      ok: false,
      error: "template target is required",
      entry: null,
      resolveErrors: [],
    };
  }

  const resolved = resolveTemplateReference(projectRoot, rawTarget, {
    allowPath: options.allowPath !== false,
    cwd: options.cwd || projectRoot,
    ...(options.templatesOptions || {}),
  });
  if (!resolved.entry) {
    const details = formatResolveErrors(resolved.errors || []);
    return {
      ok: false,
      error: details
        ? `failed to load template "${rawTarget}": ${details}`
        : `template not found: ${rawTarget}`,
      entry: null,
      resolveErrors: resolved.errors || [],
    };
  }

  return {
    ok: true,
    error: "",
    entry: resolved.entry,
    resolveErrors: resolved.errors || [],
  };
}

function validateTemplateEntry(projectRoot, entry, options = {}) {
  const promptRegistry = loadPromptProfileRegistry(projectRoot, options.promptProfilesOptions || {});
  if (promptRegistry.errors.length > 0) {
    return {
      ok: false,
      error: "prompt profile registry invalid",
      errors: promptRegistry.errors.slice(),
      entry,
      promptRegistry,
      promptProfiles: [],
    };
  }

  const result = validateTemplate(entry.data, { promptProfileRegistry: promptRegistry });
  return {
    ok: result.ok,
    error: result.ok ? "" : "template validation failed",
    errors: result.errors || [],
    entry,
    promptRegistry,
    promptProfiles: result.promptProfiles || [],
  };
}

function validateTemplateTarget(projectRoot, target, options = {}) {
  const resolved = resolveTemplateTarget(projectRoot, target, options);
  if (!resolved.ok || !resolved.entry) {
    return {
      ok: false,
      error: resolved.error,
      errors: resolved.resolveErrors || [],
      entry: null,
      promptRegistry: null,
      promptProfiles: [],
    };
  }
  return validateTemplateEntry(projectRoot, resolved.entry, options);
}

module.exports = {
  formatResolveErrors,
  resolveTemplateTarget,
  validateTemplateEntry,
  validateTemplateTarget,
};
