"use strict";

const MAX_SYMBOLS = 80;
const MAX_REGIONS = 40;

function buildSymbolsFromContent(content = "", pathHint = "") {
  const text = String(content || "");
  const lines = text.split(/\r?\n/);
  const symbols = [];
  const patterns = [
    { kind: "function", re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/ },
    { kind: "class", re: /^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/ },
    { kind: "const", re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/ },
    { kind: "method", re: /^\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/ },
    { kind: "rust_fn", re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
    { kind: "python_def", re: /^(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
  ];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of patterns) {
      const match = line.match(pattern.re);
      if (!match) continue;
      const name = String(match[1] || "").trim();
      if (!name || name === "if" || name === "for" || name === "while" || name === "switch") continue;
      symbols.push({
        name,
        kind: pattern.kind,
        line: i + 1,
        path: pathHint || "",
      });
      break;
    }
    if (symbols.length >= MAX_SYMBOLS) break;
  }
  return symbols;
}

function buildRegionsFromContent(content = "", pathHint = "") {
  const text = String(content || "");
  const lines = text.split(/\r?\n/);
  const regions = [];
  let current = null;

  const startRe = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+[A-Za-z0-9_$]+|^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[A-Za-z0-9_]+|^(?:async\s+)?def\s+[A-Za-z0-9_]+/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (startRe.test(line)) {
      if (current) {
        current.endLine = i;
        regions.push(current);
      }
      current = {
        path: pathHint || "",
        startLine: i + 1,
        endLine: i + 1,
        label: line.trim().slice(0, 120),
      };
    }
    if (regions.length >= MAX_REGIONS) break;
  }
  if (current && regions.length < MAX_REGIONS) {
    current.endLine = lines.length;
    regions.push(current);
  }
  return regions;
}

function buildArtifactIndex({
  tool = "",
  raw = null,
  args = {},
} = {}) {
  const name = String(tool || "").trim().toLowerCase();
  const source = raw && typeof raw === "object" ? raw : {};
  const pathHint = String((args && args.path) || source.path || "").trim();

  if (name === "read" || name === "skill") {
    const content = String(source.content || "");
    return {
      symbols: buildSymbolsFromContent(content, pathHint),
      regions: buildRegionsFromContent(content, pathHint),
      path: pathHint,
      totalLines: content ? content.split(/\r?\n/).length : 0,
    };
  }

  if (name === "bash") {
    const command = String((args && args.command) || source.command || "");
    const stdout = String(source.stdout || "");
    if (/\bgit\s+(?:diff|show)\b/i.test(command)) {
      const { parseGitDiffFiles } = require("./reducers");
      return {
        kind: "git_diff",
        files: parseGitDiffFiles(stdout),
        path: pathHint,
      };
    }
    if (/\b(rg|ripgrep|grep)\b/i.test(command)) {
      const { parseSearchMatches } = require("./reducers");
      const matches = parseSearchMatches(stdout);
      return {
        kind: "search",
        matchCount: matches.length,
        paths: Array.from(new Set(matches.map((m) => m.path))).slice(0, 40),
      };
    }
    if (/\b(npm test|jest|vitest|pytest|cargo test)\b/i.test(command)) {
      const { extractTestFailures } = require("./reducers");
      return {
        kind: "test",
        failures: extractTestFailures(stdout, String(source.stderr || "")),
      };
    }
  }

  return {};
}

function findSymbolInIndex(index = {}, symbolName = "") {
  const target = String(symbolName || "").trim().toLowerCase();
  if (!target) return null;
  const symbols = index && Array.isArray(index.symbols) ? index.symbols : [];
  return symbols.find((entry) => String(entry.name || "").toLowerCase() === target) || null;
}

function findRegionInIndex(index = {}, labelOrLine = "") {
  const regions = index && Array.isArray(index.regions) ? index.regions : [];
  if (regions.length === 0) return null;
  const asLine = Number(labelOrLine);
  if (Number.isFinite(asLine) && asLine > 0) {
    return regions.find((region) => region.startLine <= asLine && region.endLine >= asLine) || null;
  }
  const label = String(labelOrLine || "").trim().toLowerCase();
  if (!label) return null;
  return regions.find((region) => String(region.label || "").toLowerCase().includes(label)) || null;
}

function selectorFromSymbol(index = {}, symbolName = "", padLines = 8) {
  const symbol = findSymbolInIndex(index, symbolName);
  if (!symbol) return null;
  const startLine = Math.max(1, Number(symbol.line) - Math.max(0, padLines));
  const endLine = Number(symbol.line) + Math.max(0, padLines);
  return {
    startLine,
    endLine,
    symbol: symbol.name,
    kind: symbol.kind,
  };
}

module.exports = {
  MAX_SYMBOLS,
  MAX_REGIONS,
  buildSymbolsFromContent,
  buildRegionsFromContent,
  buildArtifactIndex,
  findSymbolInIndex,
  findRegionInIndex,
  selectorFromSymbol,
};
