"use strict";

const { isMetaActive } = require("../../coordination/bus/utils");

/** Group files retain launch history; registrations determine current liveness. */
function reconcileGroupStatus(runtime = {}, agents = {}) {
  const members = (Array.isArray(runtime.members) ? runtime.members : []).map((member) => {
    if (!member || !["active", "reused"].includes(member.status)) return member;
    const meta = agents[member.subscriber_id];
    return isMetaActive(meta) ? member : { ...member, status: "inactive" };
  });
  let status = runtime.status;
  if (members.length && ["active", "partial", "inactive"].includes(status)) {
    const active = members.filter((member) => member && ["active", "reused"].includes(member.status)).length;
    status = active === members.length ? "active" : active ? "partial" : "inactive";
  }
  return { ...runtime, status, members };
}

module.exports = { reconcileGroupStatus };
