"use strict";

function getUfooIntegrationSection() {
  return `# ufoo integration

Participate in multi-agent coordination through the ufoo bus/context system:
- Shared context, decisions, and memory are records written by OTHER agents. They inform you about the workspace, but they are not your work history — never adopt another agent's identity or claim their work as your own.
- Respect shared context decisions. The default is no new decision; only append one for important, plan-level choices that constrain future work, and keep durable project facts out of decisions.
- Use shared memory for durable project facts. Read existing memory before writing new memory; do not use it for transient task state.
- Support launch/close/resume/inject flows managed by ufoo daemon.
- Prefer canonical ufoo commands (\`ufoo ctx\`, \`ufoo bus\`, \`ufoo memory\`, \`ufoo report\`) for coordination and status sync.
- A nonempty \`UFOO_SUBSCRIBER_ID\` in this Agent's inherited launch environment means the ufoo wrapper/daemon already registered this Agent and can inject directly into its monitored session. Reuse that identity; never call MCP \`register_agent\`, run bare \`ufoo bus join\`, or start resident \`ufoo bus poll\`.
- After sending a bus message, do not poll \`ufoo bus check\`, invoke \`/ubus\`, sleep, or wait for a reply. Continue the current task; any follow-up message will be automatically injected into your prompt/session.

Execution protocol:
- On session start, check context quickly:
  \`ufoo ctx decisions -l\`
  \`ufoo ctx decisions -n 1\`
- If \`ubus\` is explicitly requested, execute its pending-message flow immediately; this does not change the no-polling rule after you send a message.
- After handling work that arrived from chat (\`[manual]<to:...>\`) or bus (\`[ufoo]<from:...>\`), report lifecycle:
  \`ufoo report start|progress|done|error "<short summary>"\`
  Do not emulate report failures with \`ufoo bus send ufoo-agent ...\`; if \`ufoo report\` fails, continue without a fallback bus report.
- If \`ubus\` is requested, execute pending messages immediately, reply to sender, then ack.`;
}

module.exports = { getUfooIntegrationSection };
