"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");
const { updateAgentsData } = require("../../coordination/state/agentsStore");
const { withFileLock } = require("../../coordination/state/fileLock");

const validGroupId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id);

function loadRecoveryGroups(projectRoot) {
  const dir = getUfooPaths(projectRoot).groupsDir;
  if (!fs.existsSync(dir)) return [];
  const groups = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
      if (validGroupId(runtime.group_id) && entry.name === `${runtime.group_id}.json` && Array.isArray(runtime.members)) groups.push(runtime);
    } catch { /* A damaged group must not hide other recoverable sessions. */ }
  }
  return groups;
}

function resolveRecoveryGroup(groups, subscriberId, meta = {}) {
  const matches = groups.filter((group) => group.members.some((member) => member?.subscriber_id === subscriberId));
  const group = meta.group_id
    ? groups.find((item) => item.group_id === meta.group_id)
    : matches.length === 1 ? matches[0] : null;
  const groupId = group?.group_id || (validGroupId(meta.group_id) ? meta.group_id : "");
  const member = group?.members.find((item) => item?.subscriber_id === subscriberId);
  return {
    group_id: groupId,
    group_member_id: member?.id || meta.group_member_id || "",
    group_template_alias: group?.template_alias || meta.group_template_alias || "",
  };
}

function associateAgentWithGroup(projectRoot, subscriberId, association) {
  if (!subscriberId || !validGroupId(association.group_id)) return;
  updateAgentsData(getUfooPaths(projectRoot).agentsFile, (data) => {
    const meta = data.agents[subscriberId];
    if (!meta) return false;
    Object.assign(meta, association);
  });
}

function recordGroupMemberResume(projectRoot, association, previousId, subscriberId) {
  if (!validGroupId(association.group_id)) return;
  const file = path.join(getUfooPaths(projectRoot).groupsDir, `${association.group_id}.json`);
  if (!fs.existsSync(file)) return;
  withFileLock(file, () => {
    const runtime = JSON.parse(fs.readFileSync(file, "utf8"));
    const member = runtime.members?.find((item) => item.subscriber_id === previousId);
    if (!member) return;
    const now = new Date().toISOString();
    member.previous_subscriber_id = previousId;
    member.subscriber_id = subscriberId;
    if (member.bootstrapped_subscriber_id === previousId) member.bootstrapped_subscriber_id = subscriberId;
    member.status = "active";
    member.resumed_at = now;
    delete member.stop;
    member.launch = { ...member.launch, mode: "internal", subscriber_ids: [subscriberId], resumed: true };
    runtime.status = runtime.members.every((item) => ["active", "reused"].includes(item.status)) ? "active" : "partial";
    runtime.updated_at = now;
    fs.writeFileSync(file, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  });
}

module.exports = { loadRecoveryGroups, resolveRecoveryGroup, associateAgentWithGroup, recordGroupMemberResume };
