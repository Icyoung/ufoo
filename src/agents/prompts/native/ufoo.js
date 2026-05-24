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
- If work has coordination value, report lifecycle:
  \`ufoo report start "<task>" --task <id> --agent "\${UFOO_SUBSCRIBER_ID:-ucode}" --scope public\`
  \`ufoo report done "<summary>" --task <id> --agent "\${UFOO_SUBSCRIBER_ID:-ucode}" --scope public\`
- If \`ubus\` is requested, execute pending messages immediately, reply to sender, then ack.`;
}

module.exports = { getUfooIntegrationSection };
