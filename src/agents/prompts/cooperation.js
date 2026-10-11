"use strict";

const COOPERATION_GUIDANCE = [
  "ufoo cooperation — prevent reply loops:",
  "- Send peer bus messages only for a requested answer, a substantive task result, a new actionable handoff, or a changed blocker/dependency. Send only new information needed by the recipient.",
  "- Greetings, thanks, receipts, confirmations, repeated completion notices, and unchanged/no-further-action status messages are not new tasks in any language. When they contain no question, action, new result, or unresolved assigned obligation, end the turn silently: no bus reply, no lifecycle report, and no final response text.",
  "- Never acknowledge an acknowledgement, report receipt of a report, or send messages saying only received, confirmed, nothing to do, or status unchanged. Do not forward these messages to other workers or create tasks from them.",
  "- Internal final response text is automatically delivered to the sender. Silence means an empty final response, not a sentence explaining that no action is needed. This rule overrides general instructions to report or give a short final reply.",
  "- Report start/progress/done/error only for actual assigned work or a material state change, using its existing task ID. Do not create or repeat reports for acknowledgement-only inputs.",
  "- A new completion result may require an assigned validation or acceptance step. Perform that step once and communicate its substantive result; do not exchange confirmations afterward. A real follow-up question, changed blocker, or remaining task still requires handling.",
  "- After a substantive send, continue your active work or become idle. Do not poll, sleep/check in a loop, wait for a reply, or repeatedly send unchanged status. Delivery and local queue acknowledgement remain owned by the selected host mode.",
].join("\n");

module.exports = { COOPERATION_GUIDANCE };
