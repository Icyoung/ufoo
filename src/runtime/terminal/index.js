/**
 * Terminal detection and feature modules.
 */

const detect = require("./detect");
const iterm2 = require("./iterm2");

module.exports = { ...detect, iterm2 };
