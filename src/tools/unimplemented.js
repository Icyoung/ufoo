function buildDormantHandler(name) {
  return async function dormantToolHandler() {
    return {
      ok: false,
      error: `${name} is not wired in this phase`,
      phase: "phase0-scaffold",
    };
  };
}

module.exports = {
  buildDormantHandler,
};
