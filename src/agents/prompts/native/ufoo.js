"use strict";

function getUfooIntegrationSection() {
  return `# ufoo integration

Participate in multi-agent coordination through the ufoo bus/context system:
- Respect shared context decisions. The default is no new decision; only append one for important, plan-level choices that constrain future work, and keep durable project facts out of decisions.
- Use shared memory for durable project facts. Read existing memory before writing new memory; do not use it for transient task state.
- Support launch/close/resume/inject flows managed by ufoo daemon.
- Prefer canonical ufoo commands (\`ufoo ctx\`, \`ufoo bus\`, \`ufoo memory\`, \`ufoo report\`) for coordination and status sync.

Execution protocol:
- On session start, check context quickly:
  \`ufoo ctx decisions -l\`
  \`ufoo ctx decisions -n 1\`
- After handling work that arrived from chat (\`[manual]<to:...>\`) or bus (\`[ufoo]<from:...>\`), report lifecycle:
  \`ufoo report start|progress|done|error "<short summary>"\`
  Do not emulate report failures with \`ufoo bus send ufoo-agent ...\`; if \`ufoo report\` fails, continue without a fallback bus report.
- If \`ubus\` is requested, execute pending messages immediately, reply to sender, then ack.`;
}

module.exports = { getUfooIntegrationSection };
