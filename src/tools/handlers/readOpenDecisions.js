const DecisionsManager = require("../../context/decisions");

function readOpenDecisionsHandler(ctx = {}, args = {}) {
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
    ? Math.floor(Number(args.limit))
    : 20;
  const manager = new DecisionsManager(ctx.projectRoot);
  const decisions = manager.readDecisions()
    .filter((item) => String(item.status || "open").trim().toLowerCase() === "open")
    .slice(0, limit)
    .map((item) => ({
      file: item.file,
      title: item.title,
      status: item.status,
      file_path: item.filePath,
    }));

  return {
    count: decisions.length,
    decisions,
  };
}

module.exports = {
  readOpenDecisionsHandler,
};
