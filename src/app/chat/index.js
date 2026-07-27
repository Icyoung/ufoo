async function runChat(projectRoot, options = {}) {
  const { resolveTuiLaunchPlan } = require("../../ui/tuiLauncher");
  const plan = resolveTuiLaunchPlan({
    mode: options.tuiMode || process.env.UFOO_TUI,
  });

  if (plan.mode !== "rust") {
    const err = new Error(`Rust TUI unavailable (${plan.reason})`);
    err.code = "UFOO_TUI_UNAVAILABLE";
    err.plan = plan;
    throw err;
  }

  const { runChatRust } = require("../../ui/rustChatHost");
  return runChatRust(projectRoot, { ...options, tuiMode: "rust" });
}

module.exports = { runChat };
