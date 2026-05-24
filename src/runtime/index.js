"use strict";

module.exports = {
  projects: require("./projects"),
  terminal: require("./terminal"),
  contracts: {
    ...require("./contracts/eventContract"),
    ...require("./contracts/ptySocketContract"),
  },
};
