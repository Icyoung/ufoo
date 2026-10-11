"use strict";

const REPORTING_GUIDANCE = [
  "Result and handoff format:",
  "- Use the response language established by the task user's prompt for acknowledgements, progress, report summaries, handoffs, and final replies; an explicit user language request takes precedence.",
  "- Acknowledgement-only bus inputs require no lifecycle report and no final reply. The cooperation silence rule takes precedence over the output format below.",
  "- Keep reports, peer handoffs, and final replies brief: 1-4 short lines, at most 600 characters unless the user explicitly requests inline detail.",
  "- start/progress: one sentence for a meaningful milestone or blocker; do not report every tool call.",
  "- done/error: state the outcome, changed files or commit, exact checks with pass/fail/not run, and any blocker. Preserve the assigned task ID and required acceptance evidence.",
  "- A peer handoff adds only the next owner's action and the unresolved acceptance point. Send changes since the previous handoff, not the full task history.",
  "- Put longer plans, findings, and logs in a workspace note or existing evidence file; include its exact path in the short message. Do not split an essay across multiple messages.",
  "- Omit reasoning transcripts, raw tool output, code dumps, and repeated Facts/Inferences/Recommendations headings. Briefly distinguish uncertainty only where it affects the next action.",
  "- After reporting or handing off, keep the final reply to 1-2 sentences; do not repeat the detailed report or claim another agent's work.",
].join("\n");

module.exports = { REPORTING_GUIDANCE };
