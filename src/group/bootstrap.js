"use strict";

const crypto = require("crypto");

const SHARED_UFOO_PROTOCOL = [
  "ufoo protocol:",
  "- At session start, sync shared context with `ufoo ctx decisions -l` and `ufoo ctx decisions -n 1`.",
  "- Default to no new decision. Record one ONLY for important, plan-level knowledge: architectural choices, multi-option trade-off analysis, cross-agent coordination decisions, or plans that affect other agents. Do NOT record routine findings, simple bug fixes, trivial observations, or generic plan/evaluation/recommendation requests. Durable project facts belong in shared memory, not decisions. Use `ufoo ctx decisions new \"Title\"` BEFORE acting only when that bar is met.",
  "- Use `ufoo bus send <target-nickname> \"<message>\"` for agent-to-agent handoffs.",
  "- If you receive pending bus work, execute it immediately, reply to the sender, then `ufoo bus ack \"$UFOO_SUBSCRIBER_ID\"`.",
  "- Use `ufoo report` for controller/runtime status updates, not as a substitute for direct handoffs.",
].join("\n");

const SHARED_GROUP_PREFIX = [
  "You are part of a ufoo multi-agent group.",
  "",
  "Shared rules:",
  "- Stay within your role.",
  "- Prefer concise handoffs over long essays.",
  "- Surface uncertainty explicitly.",
  "- If another agent owns the next step, hand off instead of doing their job for them.",
  "- When reporting, separate facts, inferences, and recommendations.",
  "- Preserve continuity with the group's current task rather than restarting analysis from scratch.",
  "",
  SHARED_UFOO_PROTOCOL,
  "",
  "Coordination protocol:",
  "- Use direct handoff for worker-to-worker delivery.",
  "- Use private `ufoo report` updates for ufoo-agent control-plane reporting.",
  "- Do not ask ufoo-agent to forward a handoff that you already delivered directly unless you explicitly need controller dispatch help.",
].join("\n");

const SOLO_AGENT_PREFIX = [
  "You are operating as a role-specialized ufoo agent.",
  "",
  "Shared rules:",
  "- Stay within your assigned role.",
  "- Prefer direct, concrete output over generic commentary.",
  "- Surface uncertainty explicitly.",
  "- Preserve continuity with the current task instead of restarting from scratch.",
  "- Use ufoo-agent for control-plane coordination, not as a substitute for doing your role.",
  "",
  SHARED_UFOO_PROTOCOL,
].join("\n");

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function buildGroupPromptMetadata({
  groupId = "",
  templateAlias = "",
  templateName = "",
  rosterVersion = "",
  member = {},
  groupMembers = [],
  upstream = [],
  downstream = [],
} = {}) {
  return {
    group_id: asTrimmedString(groupId),
    group_name: asTrimmedString(templateName) || asTrimmedString(templateAlias),
    template_alias: asTrimmedString(templateAlias),
    roster_version: asTrimmedString(rosterVersion),
    controller_id: "ufoo-agent",
    self_nickname: asTrimmedString(member.nickname),
    self_role: asTrimmedString(member.role),
    prompt_profile: asTrimmedString(member.prompt_profile),
    resolved_profile: asTrimmedString(member.resolved_profile),
    depends_on: Array.isArray(member.depends_on) ? member.depends_on.slice() : [],
    accept_from: Array.isArray(member.accept_from) ? member.accept_from.slice() : [],
    report_to: Array.isArray(member.report_to) ? member.report_to.slice() : [],
    member_count: Array.isArray(groupMembers) ? groupMembers.length : 0,
    group_members: Array.isArray(groupMembers) ? groupMembers.slice() : [],
    upstream: Array.isArray(upstream) ? upstream.slice() : [],
    downstream: Array.isArray(downstream) ? downstream.slice() : [],
  };
}

function buildRuntimeMetadataBlock(metadata = {}) {
  return `Runtime metadata:\n${JSON.stringify(metadata, null, 2)}`;
}

function buildSoloPromptMetadata({
  nickname = "",
  agentType = "",
  requestedProfile = "",
  resolvedProfile = "",
  displayName = "",
  shortName = "",
  summary = "",
  source = "",
} = {}) {
  return {
    controller_id: "ufoo-agent",
    self_nickname: asTrimmedString(nickname),
    self_agent_type: asTrimmedString(agentType),
    prompt_profile: asTrimmedString(requestedProfile),
    resolved_profile: asTrimmedString(resolvedProfile),
    display_name: asTrimmedString(displayName),
    short_name: asTrimmedString(shortName),
    profile_summary: asTrimmedString(summary),
    profile_source: asTrimmedString(source),
  };
}

function composeGroupBootstrapPrompt({
  sharedPrefix = SHARED_GROUP_PREFIX,
  profilePrompt = "",
  metadata = {},
} = {}) {
  const segments = [];
  if (asTrimmedString(sharedPrefix)) segments.push(asTrimmedString(sharedPrefix));
  if (asTrimmedString(profilePrompt)) segments.push(asTrimmedString(profilePrompt));
  segments.push(buildRuntimeMetadataBlock(metadata));
  return `${segments.join("\n\n")}\n`;
}

function composeSoloBootstrapPrompt({
  sharedPrefix = SOLO_AGENT_PREFIX,
  profilePrompt = "",
  metadata = {},
} = {}) {
  const segments = [];
  if (asTrimmedString(sharedPrefix)) segments.push(asTrimmedString(sharedPrefix));
  if (asTrimmedString(profilePrompt)) segments.push(asTrimmedString(profilePrompt));
  segments.push(buildRuntimeMetadataBlock(metadata));
  return `${segments.join("\n\n")}\n`;
}

function computeRosterVersion(groupMembers = []) {
  return stableHash(JSON.stringify(groupMembers || [])).slice(0, 16);
}

function computeBootstrapFingerprint({
  groupId = "",
  nickname = "",
  resolvedProfile = "",
  rosterVersion = "",
  promptText = "",
  metadata = {},
} = {}) {
  return stableHash(
    JSON.stringify({
      group_id: asTrimmedString(groupId),
      nickname: asTrimmedString(nickname),
      resolved_profile: asTrimmedString(resolvedProfile),
      roster_version: asTrimmedString(rosterVersion),
      metadata,
      prompt: String(promptText || ""),
    })
  );
}

module.exports = {
  SHARED_UFOO_PROTOCOL,
  SHARED_GROUP_PREFIX,
  SOLO_AGENT_PREFIX,
  buildGroupPromptMetadata,
  buildSoloPromptMetadata,
  buildRuntimeMetadataBlock,
  composeGroupBootstrapPrompt,
  composeSoloBootstrapPrompt,
  computeRosterVersion,
  computeBootstrapFingerprint,
};
