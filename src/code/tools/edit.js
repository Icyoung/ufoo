const fs = require("fs");
const { resolveWorkspacePath } = require("./common");

function replaceOnce(text, find, replace) {
  const index = text.indexOf(find);
  if (index < 0) return { next: text, count: 0 };
  return {
    next: `${text.slice(0, index)}${replace}${text.slice(index + find.length)}`,
    count: 1,
  };
}

function replaceAll(text, find, replace) {
  if (!find) return { next: text, count: 0 };
  let count = 0;
  let cursor = 0;
  let out = "";
  while (cursor < text.length) {
    const index = text.indexOf(find, cursor);
    if (index < 0) {
      out += text.slice(cursor);
      break;
    }
    count += 1;
    out += text.slice(cursor, index);
    out += replace;
    cursor = index + find.length;
  }
  return { next: out, count };
}

function runEditTool(input = {}, options = {}) {
  try {
    const filePath = String(input.path || input.file || "").trim();
    const find = String(input.find || input.search || "");
    const replace = String(input.replace || "");
    if (!find) {
      return {
        ok: false,
        error: "find pattern is required",
      };
    }
    const { workspaceRoot, resolved } = resolveWorkspacePath(options.workspaceRoot, filePath, options.cwd);
    const original = fs.readFileSync(resolved, "utf8");
    const all = input.all === true;
    const applied = all
      ? replaceAll(original, find, replace)
      : replaceOnce(original, find, replace);
    const changed = applied.count > 0;
    if (!changed) {
      return {
        ok: false,
        workspaceRoot,
        path: resolved,
        changed: false,
        replacements: 0,
        error: `find pattern not found in ${resolved}`,
      };
    }
    fs.writeFileSync(resolved, applied.next, "utf8");
    return {
      ok: true,
      workspaceRoot,
      path: resolved,
      changed: true,
      replacements: applied.count,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "edit failed",
    };
  }
}

module.exports = {
  runEditTool,
};
