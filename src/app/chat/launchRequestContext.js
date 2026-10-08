"use strict";

function defaultResolveTerminalApp() {
  const program = String(process.env.TERM_PROGRAM || "").trim();
  if (program === "Apple_Terminal") return "terminal";
  if (program === "iTerm.app" || process.env.ITERM_SESSION_ID) return "iterm2";
  return "";
}

function collectHostLaunchRequestContext(env = process.env) {
  const hostInjectSock = String(env.UFOO_HOST_INJECT_SOCK || env.HORIZON_INJECT_SOCK || "").trim();
  const hostDaemonSock = String(env.UFOO_HOST_DAEMON_SOCK || "").trim();
  const hostName = String(env.UFOO_HOST_NAME || "").trim();
  const hostSessionId = String(env.UFOO_HOST_SESSION_ID || env.HORIZON_SESSION_ID || "").trim();
  const context = {};
  if (hostInjectSock) context.host_inject_sock = hostInjectSock;
  if (hostDaemonSock) context.host_daemon_sock = hostDaemonSock;
  if (hostName) context.host_name = hostName;
  if (hostSessionId) context.host_session_id = hostSessionId;
  return context;
}

function collectTerminalLaunchRequestContext(resolveTerminalApp = defaultResolveTerminalApp) {
  const terminalApp = String(resolveTerminalApp() || "").trim().toLowerCase();
  if (terminalApp === "terminal" || terminalApp === "iterm2") {
    return { terminal_app: terminalApp };
  }
  return {};
}

function collectTmuxLaunchRequestContext(env = process.env) {
  const tmuxTarget = String(env.UFOO_TMUX_TARGET || "").trim();
  const tmuxPane = String(env.UFOO_TMUX_PANE || env.TMUX_PANE || "").trim();
  const tmuxSession = String(env.UFOO_TMUX_SESSION || "").trim();
  const context = {};
  if (tmuxTarget) context.tmux_target = tmuxTarget;
  if (tmuxPane) context.tmux_pane = tmuxPane;
  if (tmuxSession) context.tmux_session = tmuxSession;
  return context;
}

module.exports = { defaultResolveTerminalApp, collectHostLaunchRequestContext, collectTerminalLaunchRequestContext, collectTmuxLaunchRequestContext };
