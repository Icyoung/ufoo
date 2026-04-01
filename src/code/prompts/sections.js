"use strict";

/**
 * Section caching infrastructure for the ucode prompt system.
 *
 * Adapted from Claude Code's systemPromptSections.ts pattern:
 * - systemPromptSection(): computed once, cached until clearSectionCache()
 * - uncachedSection(): recomputed every call (breaks prompt cache)
 * - resolveSections(): batch-resolve an array of sections
 */

const _cache = new Map();

/**
 * Create a memoized system prompt section.
 * Computed once, cached until clearSectionCache() is called.
 */
function systemPromptSection(name, computeFn) {
  return { name, compute: computeFn, cacheBreak: false };
}

/**
 * Create a volatile section that recomputes every time.
 * Use sparingly — this breaks prompt cache when the value changes.
 */
function uncachedSection(name, computeFn) {
  return { name, compute: computeFn, cacheBreak: true };
}

/**
 * Resolve all sections, returning an array of strings (or nulls).
 * Cached sections are computed once; uncached sections recompute every call.
 */
function resolveSections(sections) {
  const results = [];
  for (const s of sections) {
    if (!s.cacheBreak && _cache.has(s.name)) {
      results.push(_cache.get(s.name) ?? null);
      continue;
    }
    const value = typeof s.compute === "function" ? s.compute() : null;
    _cache.set(s.name, value);
    results.push(value);
  }
  return results;
}

/**
 * Clear all cached sections. Call on session clear or reset.
 */
function clearSectionCache() {
  _cache.clear();
}

module.exports = {
  systemPromptSection,
  uncachedSection,
  resolveSections,
  clearSectionCache,
};
