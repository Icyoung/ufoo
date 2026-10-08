"use strict";

const { createSessionJournal } = require("../../agents/runtime/context/sessionJournal");
// Preserve existing ucode journal/transcript paths and exported functions.
module.exports = createSessionJournal({ namespace: "ucode" });
