const chalk = require("chalk");

/**
 * 显示 agent 启动横幅
 */
function showBanner(options) {
  const { agentType, sessionId, nickname, daemonStatus } = options;

  // ASCII art logo (6 行)
  const logo = [
    "██╗   ██╗███████╗ ██████╗  ██████╗",
    "██║   ██║██╔════╝██╔═══██╗██╔═══██╗",
    "██║   ██║█████╗  ██║   ██║██║   ██║",
    "██║   ██║██╔══╝  ██║   ██║██║   ██║",
    "╚██████╔╝██║     ╚██████╔╝╚██████╔╝",
    " ╚═════╝ ╚═╝      ╚═════╝  ╚═════╝"
  ];

  // 准备右侧信息行（确保标签对齐）
  const infoLines = [];

  // Nickname 行（放在第一位）
  if (nickname) {
    const nicknameLabel = chalk.dim("Nickname: ");
    const nicknameValue = chalk.cyan.bold(nickname);
    infoLines.push(`${nicknameLabel}${nicknameValue}`);
  }

  // Agent 行
  const agentLabel = chalk.dim("Agent:    ");
  const agentValue = chalk.green.bold(agentType);
  infoLines.push(`${agentLabel}${agentValue}`);

  // Session 行
  const sessionLabel = chalk.dim("Session:  ");
  const sessionValue = chalk.yellow(sessionId);
  infoLines.push(`${sessionLabel}${sessionValue}`);

  // Daemon 行
  if (daemonStatus) {
    const daemonLabel = chalk.dim("Daemon:   ");
    const statusColor = daemonStatus === "running" ? chalk.green : chalk.blue;
    const daemonValue = statusColor(daemonStatus);
    infoLines.push(`${daemonLabel}${daemonValue}`);
  }

  // 计算垂直居中偏移（logo 6 行，信息通常 4 行，偏移 1 行使其居中）
  const verticalOffset = Math.floor((logo.length - infoLines.length) / 2);

  // 输出：Logo 和信息并排显示，信息垂直居中
  console.log("");
  logo.forEach((line, index) => {
    const logoLine = chalk.cyan(line);
    const infoIndex = index - verticalOffset;
    const infoLine = (infoIndex >= 0 && infoIndex < infoLines.length)
      ? infoLines[infoIndex]
      : "";
    console.log(`  ${logoLine}  ${infoLine}`);
  });
  console.log("");
}

/**
 * 显示 ufoo 主命令横幅
 */
function showUfooBanner(options = {}) {
  const { version = "1.0.0" } = options;

  // ASCII art logo (6 行)
  const logo = [
    "██╗   ██╗███████╗ ██████╗  ██████╗",
    "██║   ██║██╔════╝██╔═══██╗██╔═══██╗",
    "██║   ██║█████╗  ██║   ██║██║   ██║",
    "██║   ██║██╔══╝  ██║   ██║██║   ██║",
    "╚██████╔╝██║     ╚██████╔╝╚██████╔╝",
    " ╚═════╝ ╚═╝      ╚═════╝  ╚═════╝"
  ];

  // 准备右侧信息行
  const infoLines = [];

  // Version 行
  const versionLabel = chalk.dim("Version: ");
  const versionValue = chalk.cyan.bold(`v${version}`);
  infoLines.push(`${versionLabel}${versionValue}`);

  // Tagline
  const tagline = chalk.gray("Multi-Agent Workspace Protocol");
  infoLines.push(tagline);

  // 空行
  infoLines.push("");

  // 快捷命令
  const cmdLabel = chalk.dim("Commands:");
  infoLines.push(cmdLabel);

  // 计算垂直居中偏移
  const verticalOffset = Math.floor((logo.length - infoLines.length) / 2);

  // 输出：Logo 和信息并排显示，信息垂直居中
  console.log("");
  logo.forEach((line, index) => {
    const logoLine = chalk.cyan(line);
    const infoIndex = index - verticalOffset;
    const infoLine = (infoIndex >= 0 && infoIndex < infoLines.length)
      ? infoLines[infoIndex]
      : "";
    console.log(`  ${logoLine}  ${infoLine}`);
  });

  // 命令列表（在 logo 下方）
  console.log("");
  console.log(`    ${chalk.dim("uclaude")}   ${chalk.gray("Launch Claude Code agent")}`);
  console.log(`    ${chalk.dim("ucodex")}    ${chalk.gray("Launch Codex agent")}`);
  console.log(`    ${chalk.dim("ufoo init")} ${chalk.gray("Initialize workspace")}`);
  console.log(`    ${chalk.dim("ufoo ctx")}  ${chalk.gray("Context management")}`);
  console.log(`    ${chalk.dim("ufoo bus")}  ${chalk.gray("Event bus operations")}`);
  console.log("");
}

module.exports = { showBanner, showUfooBanner };
