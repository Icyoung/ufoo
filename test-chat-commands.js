#!/usr/bin/env node
/**
 * Simple command test tool
 */

const path = require("path");
const projectRoot = __dirname;

console.log("Project root:", projectRoot);
console.log();

// Test command parsing
function parseCommand(text) {
  if (!text.startsWith("/")) return null;
  const parts = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  if (parts.length === 0) return null;
  const command = parts[0].slice(1);
  const args = parts.slice(1).map(arg => arg.replace(/^"|"$/g, ""));
  return { command, args };
}

// Test cases
const tests = [
  "/doctor",
  "/status",
  "/daemon status",
  "/bus list",
  "/bus send worker hello",
  '/bus rename worker "new-name"',
  "/ctx",
  "/skills list",
  "/launch claude",
  "/launch claude nickname=worker count=2",
];

console.log("=== Command Parsing Tests ===\n");

for (const test of tests) {
  const parsed = parseCommand(test);
  if (parsed) {
    console.log(`Input:   "${test}"`);
    console.log(`Command: "${parsed.command}"`);
    console.log(`Args:    [${parsed.args.map(a => `"${a}"`).join(", ")}]`);
    console.log();
  }
}

// Test module loading
console.log("=== Module Loading Tests ===\n");

const modules = [
  ["doctor", "./src/doctor"],
  ["init", "./src/init"],
  ["bus", "./src/bus"],
  ["context", "./src/context"],
  ["skills", "./src/skills"],
  ["launcher", "./src/agent/launcher"],
  ["activate", "./src/bus/activate"],
];

for (const [name, modulePath] of modules) {
  try {
    const mod = require(modulePath);
    console.log(`✓ ${name.padEnd(12)} ${modulePath}`);
  } catch (err) {
    console.log(`✗ ${name.padEnd(12)} ${modulePath}`);
    console.log(`  Error: ${err.message}`);
  }
}

console.log("\n=== Test Complete ===");
