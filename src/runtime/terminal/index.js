/**
 * Terminal detection and feature helpers.
 */

const detect = require("./detect");
const iterm2 = require("./iterm2");

module.exports = { ...detect, iterm2 };
