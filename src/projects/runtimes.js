function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectLabel(row = {}) {
  return String(row.project_name || row.project_root || "");
}

function normalizeInteractionMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function filterVisibleProjectRuntimes(rows = []) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  return sourceRows.filter((row) => {
    const status = String((row && row.status) || "").trim().toLowerCase();
    return status !== "stopped";
  });
}

function sortProjectRuntimes(options = {}) {
  const {
    rows = [],
    activeProjectRoot = "",
    resolveProjectRoot = (row) => String((row && row.project_root) || ""),
    getInteractionMs = () => 0,
  } = options;
  const sourceRows = Array.isArray(rows) ? rows.slice() : [];
  // Keep arg usage for backward compatibility with existing callers/tests.
  void activeProjectRoot;
  void resolveProjectRoot;

  sourceRows.sort((a, b) => {
    const bInteraction = normalizeInteractionMs(getInteractionMs(b));
    const aInteraction = normalizeInteractionMs(getInteractionMs(a));
    if (bInteraction !== aInteraction) return bInteraction - aInteraction;

    const bSeen = parseTimestampMs(b && b.last_seen);
    const aSeen = parseTimestampMs(a && a.last_seen);
    if (bSeen !== aSeen) return bSeen - aSeen;

    return projectLabel(a).localeCompare(projectLabel(b), "en", { sensitivity: "base" });
  });

  return sourceRows;
}

module.exports = {
  sortProjectRuntimes,
  parseTimestampMs,
  filterVisibleProjectRuntimes,
};
