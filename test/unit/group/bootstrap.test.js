"use strict";

const {
  SHARED_UFOO_PROTOCOL,
  SHARED_GROUP_PREFIX,
  buildGroupPromptMetadata,
  composeGroupBootstrapPrompt,
} = require("../../../src/group/bootstrap");

describe("group bootstrap", () => {
  test("shared ufoo protocol includes decisions and bus handoff guidance", () => {
    expect(SHARED_UFOO_PROTOCOL).toContain("ufoo ctx decisions -l");
    expect(SHARED_UFOO_PROTOCOL).toContain("ufoo ctx decisions new");
    expect(SHARED_UFOO_PROTOCOL).toContain("ufoo bus send <target-nickname>");
    expect(SHARED_UFOO_PROTOCOL).toContain("ufoo bus ack \"$UFOO_SUBSCRIBER_ID\"");
  });

  test("shared prefix documents direct handoff vs private control-plane reporting", () => {
    expect(SHARED_GROUP_PREFIX).toContain("Use direct handoff for worker-to-worker delivery.");
    expect(SHARED_GROUP_PREFIX).toContain("Use private `ufoo report` updates for ufoo-agent control-plane reporting.");
    expect(SHARED_GROUP_PREFIX).toContain("Do not ask ufoo-agent to forward a handoff that you already delivered directly");
  });

  test("metadata includes controller id", () => {
    const metadata = buildGroupPromptMetadata({
      groupId: "group-1",
      templateAlias: "product-discovery",
      templateName: "Product Discovery",
      rosterVersion: "roster-1",
      member: {
        nickname: "facilitator",
        role: "clarify",
        prompt_profile: "discovery-facilitator",
        resolved_profile: "discovery-facilitator",
      },
      groupMembers: [],
      upstream: [],
      downstream: [],
    });

    expect(metadata.controller_id).toBe("ufoo-agent");
  });

  test("composed bootstrap prompt includes control-plane guidance and metadata", () => {
    const prompt = composeGroupBootstrapPrompt({
      profilePrompt: "Role prompt",
      metadata: {
        group_id: "group-1",
        controller_id: "ufoo-agent",
      },
    });

    expect(prompt).toContain("Use private `ufoo report` updates for ufoo-agent control-plane reporting.");
    expect(prompt).toContain("ufoo ctx decisions -l");
    expect(prompt).toContain("ufoo bus send <target-nickname>");
    expect(prompt).toContain("\"controller_id\": \"ufoo-agent\"");
  });
});
