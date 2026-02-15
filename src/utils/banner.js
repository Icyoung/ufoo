const chalk = require("chalk");

/**
 * 显示 agent 启动横幅
 */
function showBanner(options) {
  const { agentType, sessionId, nickname, daemonStatus } = options;

  // Compact logo (3 行)
  const logo = [
    "█ █ █▀▀ █▀█ █▀█",
    "█ █ █▀  █ █ █ █",
    "▀▀▀ ▀   ▀▀▀ ▀▀▀",
  ];

  // Normalize agent type display name
  const displayAgentType = agentType === "ufoo-code" ? "ucode" : agentType;

  // 准备右侧信息行
  const infoLines = [];
  if (nickname) {
    infoLines.push(`${chalk.dim("Nickname:")} ${chalk.cyan.bold(nickname)}`);
  }
  infoLines.push(`${chalk.dim("Agent:")} ${chalk.green.bold(displayAgentType)}${chalk.dim(":")}${chalk.yellow(sessionId)}`);
  if (daemonStatus) {
    const statusColor = daemonStatus === "running" ? chalk.green : chalk.blue;
    infoLines.push(`${chalk.dim("Daemon:")} ${statusColor(daemonStatus)}`);
  }

  // 计算垂直居中偏移
  const verticalOffset = Math.floor((logo.length - infoLines.length) / 2);

  // 输出：Logo 和信息并排显示
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

  // Compact logo (3 行)
  const logo = [
    "█ █ █▀▀ █▀█ █▀█",
    "█ █ █▀  █ █ █ █",
    "▀▀▀ ▀   ▀▀▀ ▀▀▀",
  ];

  // 右侧信息
  const infoLines = [
    `${chalk.cyan.bold(`v${version}`)} ${chalk.gray("Multi-Agent Workspace Protocol")}`,
    "",
    chalk.dim("uclaude") + chalk.gray(" · ") + chalk.dim("ucodex") + chalk.gray(" · ") + chalk.dim("ucode") + chalk.gray(" · ") + chalk.dim("ufoo init") + chalk.gray(" · ") + chalk.dim("ufoo ctx") + chalk.gray(" · ") + chalk.dim("ufoo bus"),
  ];

  // 输出：Logo 和信息并排显示
  console.log("");
  logo.forEach((line, index) => {
    const logoLine = chalk.cyan(line);
    const infoLine = (index < infoLines.length) ? infoLines[index] : "";
    console.log(`  ${logoLine}  ${infoLine}`);
  });
  console.log("");
}

module.exports = { showBanner, showUfooBanner };
