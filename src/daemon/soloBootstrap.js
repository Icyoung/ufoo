"use strict";

const path = require("path");
const EventBus = require("../bus");
const { prepareUcodeBootstrap } = require("../agent/ucodeBootstrap");
const { isMetaActive } = require("../bus/utils");
const { getUfooPaths } = require("../ufoo/paths");
const { loadAgentsData, saveAgentsData } = require("../ufoo/agentsStore");
const {
  loadPromptProfileRegistry,
  resolvePromptProfileReference,
} = require("../group/promptProfiles");
const {
  buildSoloPromptMetadata,
  composeSoloBootstrapPrompt,
} = require("../group/bootstrap");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveSoloPromptProfile(projectRoot, reference = "", options = {}) {
  const requested = String(reference || "").trim();
  if (!requested) {
    return { ok: true, requested_profile: "", profile: null, registry: null };
  }
  const registry = loadPromptProfileRegistry(projectRoot, options);
  if (Array.isArray(registry.errors) && registry.errors.length > 0) {
    const first = registry.errors[0];
    return {
      ok: false,
      error: first && first.message ? first.message : "prompt profile registry failed to load",
      registry,
    };
  }
  const profile = resolvePromptProfileReference(registry, requested);
  if (!profile) {
    return {
      ok: false,
      error: `unknown prompt profile: ${requested}`,
      registry,
    };
  }
  return {
    ok: true,
    requested_profile: requested,
    profile,
    registry,
  };
}

function buildSoloBootstrap({
  nickname = "",
  agentType = "",
  requestedProfile = "",
  profile = null,
} = {}) {
  if (!profile) {
    return { ok: true, required: false, promptText: "", metadata: {}, profile: null };
  }
  const metadata = buildSoloPromptMetadata({
    nickname,
    agentType,
    requestedProfile,
    resolvedProfile: profile.id,
    displayName: profile.display_name,
    shortName: profile.short_name,
    summary: profile.summary,
    source: profile.source,
  });
  const promptText = composeSoloBootstrapPrompt({
    profilePrompt: profile.prompt,
    metadata,
  });
  return {
    ok: true,
    required: true,
    promptText,
    metadata,
    profile,
  };
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function getAgentRuntimeMeta(projectRoot, subscriberId) {
  try {
    const busPath = getUfooPaths(projectRoot).agentsFile;
    const bus = loadAgentsData(busPath);
    const meta = bus && bus.agents ? bus.agents[subscriberId] : null;
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

async function waitForSoloBootstrapReady(projectRoot, subscriberId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 250;
  const protectionMs = Number.isFinite(options.protectionMs) ? options.protectionMs : 3000;
  const workingGraceMs = Number.isFinite(options.workingGraceMs) ? options.workingGraceMs : 10000;
  const startedAt = Date.now();
  let lastState = "";

  while (Date.now() - startedAt < timeoutMs) {
    const meta = getAgentRuntimeMeta(projectRoot, subscriberId);
    const status = asTrimmedString(meta && meta.status).toLowerCase();
    const state = asTrimmedString(meta && meta.activity_state).toLowerCase();
    lastState = state || lastState;
    if (status && status !== "active") {
      return { ok: false, error: `agent became ${status} before bootstrap` };
    }
    const elapsed = Date.now() - startedAt;
    if (state === "ready" || state === "idle" || state === "waiting_input" || state === "blocked") {
      return { ok: true, activity_state: state };
    }
    if (state === "working") {
      if (elapsed < protectionMs) {
        await sleep(retryDelayMs);
        continue;
      }
      const activitySinceMs = parseTimestampMs(meta && meta.activity_since);
      const workingMs = Number.isFinite(activitySinceMs)
        ? Math.max(0, Date.now() - activitySinceMs)
        : elapsed;
      if (workingMs >= workingGraceMs) {
        return { ok: true, activity_state: state, degraded: true };
      }
    }
    if (!state || state === "starting" || state === "running" || state === "working") {
      await sleep(retryDelayMs);
      continue;
    }
    await sleep(retryDelayMs);
  }

  return {
    ok: false,
    error: lastState
      ? `agent not ready for bootstrap (last activity_state=${lastState})`
      : "agent not ready for bootstrap",
  };
}

async function injectSoloBootstrapPrompt(projectRoot, subscriberId, promptText, options = {}) {
  const ready = await waitForSoloBootstrapReady(projectRoot, subscriberId, options);
  if (!ready.ok) return ready;

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 250;
  const deadline = Date.now() + timeoutMs;
  const bus = new EventBus(projectRoot);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await bus.inject(subscriberId, promptText);
      return { ok: true };
    } catch (err) {
      lastError = err;
      await sleep(retryDelayMs);
    }
  }
  return {
    ok: false,
    error: lastError && lastError.message ? lastError.message : `bootstrap inject failed for ${subscriberId}`,
  };
}

function prepareSoloUcodeBootstrap(projectRoot, nickname, promptText) {
  const safeNickname = String(nickname || "agent").replace(/[^a-zA-Z0-9._-]/g, "-");
  const targetFile = path.join(getUfooPaths(projectRoot).agentDir, "ucode", `${safeNickname}-bootstrap.md`);
  return prepareUcodeBootstrap({
    projectRoot,
    targetFile,
    promptText,
  });
}

function loadBusMeta(projectRoot) {
  return loadAgentsData(getUfooPaths(projectRoot).agentsFile);
}

function isLiveAgentMeta(meta) {
  return Boolean(meta) && isMetaActive(meta);
}

function resolveExistingAgent(projectRoot, target = "") {
  const key = String(target || "").trim();
  if (!key) return null;
  const bus = loadBusMeta(projectRoot);
  const agents = bus && bus.agents ? bus.agents : {};
  if (isLiveAgentMeta(agents[key])) {
    return { subscriberId: key, meta: agents[key] };
  }
  for (const [subscriberId, meta] of Object.entries(agents)) {
    if (meta && meta.nickname === key && isLiveAgentMeta(meta)) {
      return { subscriberId, meta };
    }
  }
  return null;
}

function findOwningGroup(projectRoot, subscriberId = "") {
  const targetSubscriber = asTrimmedString(subscriberId);
  if (!targetSubscriber) return null;
  const liveMeta = getAgentRuntimeMeta(projectRoot, targetSubscriber);
  if (!isLiveAgentMeta(liveMeta)) return null;
  if (asTrimmedString(liveMeta.role_owner).toLowerCase() === "solo") return null;
  const liveNickname = asTrimmedString(liveMeta.nickname);
  const groupsDir = getUfooPaths(projectRoot).groupsDir;
  if (!groupsDir) return null;
  let files = [];
  try {
    files = require("fs").readdirSync(groupsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const fileName of files) {
    try {
      const filePath = path.join(groupsDir, fileName);
      const runtime = JSON.parse(require("fs").readFileSync(filePath, "utf8"));
      if (!runtime || runtime.status !== "active" || !Array.isArray(runtime.members)) continue;
      const found = runtime.members.find((member) =>
        member
        && asTrimmedString(member.subscriber_id) === targetSubscriber
        && (member.status === "active" || member.status === "reused")
        && asTrimmedString(member.nickname)
        && (!liveNickname || asTrimmedString(member.nickname) === liveNickname)
      );
      if (found) {
        return {
          group_id: String(runtime.group_id || "").trim(),
          template_alias: String(runtime.template_alias || "").trim(),
          nickname: String(found.nickname || "").trim(),
        };
      }
    } catch {
      // ignore malformed runtime
    }
  }
  return null;
}

function pickLaunchSubscriber(launchResult = {}, fallbackTarget = "") {
  if (launchResult && Array.isArray(launchResult.subscriber_ids) && launchResult.subscriber_ids.length > 0) {
    return asTrimmedString(launchResult.subscriber_ids[0]);
  }
  if (launchResult && launchResult.agent_id) {
    return asTrimmedString(launchResult.agent_id);
  }
  return asTrimmedString(fallbackTarget);
}

function shouldRollbackRoleAssignmentLaunch(launchResult = {}) {
  return Boolean(launchResult && launchResult.ok !== false && launchResult.skipped !== true);
}

async function rollbackLaunchAfterRoleAssignmentFailure(
  projectRoot,
  launchResult,
  fallbackTarget,
  handleOps,
  processManager = null
) {
  if (!shouldRollbackRoleAssignmentLaunch(launchResult)) {
    return { ok: true, skipped: true, rolled_back: false, target: "" };
  }
  if (typeof handleOps !== "function") {
    return { ok: false, rolled_back: false, target: "", error: "handleOps is required for rollback" };
  }
  const target = pickLaunchSubscriber(launchResult, fallbackTarget);
  if (!target) {
    return { ok: false, rolled_back: false, target: "", error: "missing subscriber_id for rollback" };
  }
  const opsResults = await handleOps(projectRoot, [{ action: "close", agent_id: target }], processManager);
  const closeResult = Array.isArray(opsResults)
    ? opsResults.find((entry) => entry && entry.action === "close")
    : null;
  if (closeResult && closeResult.ok !== false) {
    return { ok: true, skipped: false, rolled_back: true, target };
  }
  return {
    ok: false,
    skipped: false,
    rolled_back: false,
    target,
    error: closeResult && closeResult.error ? closeResult.error : "close failed",
  };
}

function persistSoloRoleMetadata(projectRoot, subscriberId, payload = {}) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const bus = loadAgentsData(filePath);
  const meta = bus.agents && bus.agents[subscriberId];
  if (!meta) return false;
  bus.agents[subscriberId] = {
    ...meta,
    bootstrap_kind: "solo",
    role_owner: "solo",
    requested_profile: String(payload.requested_profile || "").trim(),
    resolved_profile: String(payload.resolved_profile || "").trim(),
    bootstrap_fingerprint: String(payload.bootstrap_fingerprint || "").trim(),
    bootstrapped_subscriber_id: String(payload.bootstrapped_subscriber_id || subscriberId).trim(),
    role_assigned_at: new Date().toISOString(),
  };
  saveAgentsData(filePath, bus);
  return true;
}

function buildSoloBootstrapFingerprint({ subscriberId = "", requestedProfile = "", resolvedProfile = "", promptText = "" } = {}) {
  return require("crypto")
    .createHash("sha256")
    .update(JSON.stringify({
      subscriber_id: String(subscriberId || ""),
      requested_profile: String(requestedProfile || ""),
      resolved_profile: String(resolvedProfile || ""),
      prompt: String(promptText || ""),
    }))
    .digest("hex");
}

function isSameSoloAssignment(meta = {}, subscriberId = "", requestedProfile = "", resolvedProfile = "", promptText = "") {
  const currentOwner = String(meta.role_owner || "").trim();
  const currentKind = String(meta.bootstrap_kind || "").trim();
  const currentFingerprint = String(meta.bootstrap_fingerprint || "").trim();
  const nextFingerprint = buildSoloBootstrapFingerprint({
    subscriberId,
    requestedProfile,
    resolvedProfile,
    promptText,
  });
  return currentOwner === "solo"
    && currentKind === "solo"
    && currentFingerprint
    && currentFingerprint === nextFingerprint;
}

async function assignSoloRoleToExistingAgent(projectRoot, target, profileReference, options = {}) {
  const resolvedTarget = resolveExistingAgent(projectRoot, target);
  if (!resolvedTarget) {
    return { ok: false, error: `agent not found: ${target}` };
  }
  const ownership = findOwningGroup(projectRoot, resolvedTarget.subscriberId);
  if (ownership) {
    return {
      ok: false,
      error: `agent is group-owned by ${ownership.group_id || ownership.template_alias || "active-group"}`,
      group: ownership,
      subscriber_id: resolvedTarget.subscriberId,
    };
  }

  const resolvedProfile = resolveSoloPromptProfile(projectRoot, profileReference, options.promptProfilesOptions || {});
  if (!resolvedProfile.ok) return resolvedProfile;
  const built = buildSoloBootstrap({
    nickname: resolvedTarget.meta.nickname || resolvedTarget.subscriberId,
    agentType: resolvedTarget.meta.agent_type || "",
    requestedProfile: resolvedProfile.requested_profile,
    profile: resolvedProfile.profile,
  });
  if (!built.required) {
    return { ok: false, error: "prompt profile is required" };
  }

  if (isSameSoloAssignment(
    resolvedTarget.meta,
    resolvedTarget.subscriberId,
    resolvedProfile.requested_profile,
    resolvedProfile.profile.id,
    built.promptText,
  )) {
    return {
      ok: true,
      skipped: true,
      subscriber_id: resolvedTarget.subscriberId,
      requested_profile: resolvedProfile.requested_profile,
      resolved_profile: resolvedProfile.profile.id,
    };
  }

  const injected = await injectSoloBootstrapPrompt(
    projectRoot,
    resolvedTarget.subscriberId,
    built.promptText,
    options.bootstrapOptions || {},
  );
  if (!injected.ok) {
    return {
      ok: false,
      error: injected.error || "solo bootstrap inject failed",
      subscriber_id: resolvedTarget.subscriberId,
    };
  }

  const fingerprint = buildSoloBootstrapFingerprint({
    subscriberId: resolvedTarget.subscriberId,
    requestedProfile: resolvedProfile.requested_profile,
    resolvedProfile: resolvedProfile.profile.id,
    promptText: built.promptText,
  });
  persistSoloRoleMetadata(projectRoot, resolvedTarget.subscriberId, {
    requested_profile: resolvedProfile.requested_profile,
    resolved_profile: resolvedProfile.profile.id,
    bootstrap_fingerprint: fingerprint,
    bootstrapped_subscriber_id: resolvedTarget.subscriberId,
  });

  return {
    ok: true,
    subscriber_id: resolvedTarget.subscriberId,
    requested_profile: resolvedProfile.requested_profile,
    resolved_profile: resolvedProfile.profile.id,
  };
}

module.exports = {
  resolveSoloPromptProfile,
  buildSoloBootstrap,
  waitForSoloBootstrapReady,
  injectSoloBootstrapPrompt,
  prepareSoloUcodeBootstrap,
  resolveExistingAgent,
  findOwningGroup,
  persistSoloRoleMetadata,
  buildSoloBootstrapFingerprint,
  rollbackLaunchAfterRoleAssignmentFailure,
  assignSoloRoleToExistingAgent,
};
