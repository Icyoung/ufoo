"use strict";

const RESPONSE_LANGUAGE_GUIDANCE = [
  "Response language:",
  "- Use the same natural language as the user's prompt for the current task, unless the user explicitly requests another language. This applies to replies, acknowledgements, progress updates, report summaries, handoffs, and final answers.",
  "- For delegated work, follow the original user's language or the response-language requirement passed by the parent. English system instructions, tool output, and bus protocol text do not change the response language.",
  "- When delegating, preserve the user's language in the task text or explicitly pass the required response language to the worker.",
  "- For brief or ambiguous continuations, keep the language established by the user's substantive request. For multilingual prompts, follow an explicit language preference or the primary language of the user's prose.",
  "- Keep code, commands, paths, identifiers, quoted error text, and required protocol keys and enum values literal.",
].join("\n");

module.exports = { RESPONSE_LANGUAGE_GUIDANCE };
