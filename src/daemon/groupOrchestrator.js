"use strict";

const fs = require("fs");
const path = require("path");
const EventBus = require("../bus");
const { prepareUcodeBootstrap } = require("../agent/ucodeBootstrap");
const { loadConfig } = require("../config");
const {
  buildGroupPromptMetadata,
  composeGroupBootstrapPrompt,
  computeBootstrapFingerprint,
  computeRosterVersion,
} = require("../group/bootstrap");
const { validateTemplateTarget: validateGroupTemplateTarget } = require("../group/templateValidation");
const { getUfooPaths } = require("../ufoo/paths");

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asTrimmedString(item)).filter(Boolean);
}

const SAFE_GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function normalizeInstanceId(value = "") {
  const text = asTrimmedString(value);
  if (!text) return "";
  if (!SAFE_GROUP_ID_RE.test(text)) return "";
  return text;
}

function normalizeGroupId(value = "") {
  return normalizeInstanceId(value);
}

function buildLaunchPlan(templateDoc = {}) {
  const agents = Array.isArray(templateDoc.agents) ? templateDoc.agents : [];
  const remaining = new Map();
  const launched = new Set();
  const ordered = [];

  for (const agent of agents) {
    const nickname = asTrimmedString(agent && agent.nickname);
    if (!nickname) continue;
    const dependsOn = asStringArray(agent.depends_on);
    const startupOrder = Number.isInteger(agent.startup_order) ? agent.startup_order : 0;
    remaining.set(nickname, {
      id: asTrimmedString(agent.id),
      nickname,
      requested_type: asTrimmedString(agent.type),
      type: asTrimmedString(agent.type),
      role: asTrimmedString(agent.role),
      prompt_profile: asTrimmedString(agent.prompt_profile),
      startup_order: startupOrder,
      depends_on: dependsOn,
      accept_from: asStringArray(agent.accept_from),
      report_to: asStringArray(agent.report_to),
    });
  }

  let guard = 0;
  while (remaining.size > 0 && guard < 10000) {
    guard += 1;
    const ready = [];
    for (const item of remaining.values()) {
      const allDepsReady = item.depends_on.every((dep) => launched.has(dep));
      if (allDepsReady) ready.push(item);
    }
    if (ready.length === 0) {
      throw new Error("unable to compile launch plan: unresolved dependency graph");
    }

    ready.sort((a, b) => {
      if (a.startup_order !== b.startup_order) return a.startup_order - b.startup_order;
      return a.nickname.localeCompare(b.nickname, "en", { sensitivity: "base" });
    });

    for (const item of ready) {
      remaining.delete(item.nickname);
      launched.add(item.nickname);
      ordered.push(item);
    }
  }

  return ordered;
}

function ensureGroupsDir(projectRoot) {
  const dir = getUfooPaths(projectRoot).groupsDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function groupFilePath(projectRoot, groupId) {
  const raw = asTrimmedString(groupId);
  const normalized = normalizeGroupId(raw);
  if (!normalized || normalized !== raw) {
    throw new Error("invalid group_id");
  }
  return path.join(ensureGroupsDir(projectRoot), `${normalized}.json`);
}

function memberBootstrapFilePath(projectRoot, groupId, nickname) {
  return path.join(
    getUfooPaths(projectRoot).agentDir,
    "ucode",
    "groups",
    groupId,
    `${nickname}.bootstrap.md`
  );
}

function writeGroupState(projectRoot, runtime) {
  const filePath = groupFilePath(projectRoot, runtime.group_id);
  fs.writeFileSync(filePath, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  return filePath;
}

function readGroupState(projectRoot, groupId) {
  let filePath = "";
  try {
    filePath = groupFilePath(projectRoot, groupId);
  } catch {
    return null;
  }
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listGroupStates(projectRoot) {
  const dir = ensureGroupsDir(projectRoot);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .map((item) => path.join(dir, item.name))
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

  const groups = [];
  for (const filePath of entries) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      groups.push(raw);
    } catch {
      // ignore malformed runtime state
    }
  }
  return groups;
}

function readBusAgents(projectRoot) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data && data.agents ? data.agents : {};
  } catch {
    return {};
  }
}

function resolveActiveSubscriberByNickname(projectRoot, nickname) {
  if (!nickname) return "";
  const agents = readBusAgents(projectRoot);
  const entries = Object.entries(agents);
  const match = entries.find(([, meta]) => meta && meta.nickname === nickname && meta.status === "active");
  return match ? match[0] : "";
}

function summarizeGroup(runtime = {}) {
  const members = Array.isArray(runtime.members) ? runtime.members : [];
  const active = members.filter((item) => item.status === "active" || item.status === "reused").length;
  return {
    group_id: runtime.group_id || "",
    status: runtime.status || "",
    template_alias: runtime.template_alias || "",
    template_version: runtime.template_version || null,
    updated_at: runtime.updated_at || "",
    members_total: members.length,
    members_active: active,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLaunchHostContext(params = {}) {
  const hostInjectSock = asTrimmedString(params.host_inject_sock || params.hostInjectSock);
  const hostDaemonSock = asTrimmedString(params.host_daemon_sock || params.hostDaemonSock);
  const hostName = asTrimmedString(params.host_name || params.hostName);
  const hostSessionId = asTrimmedString(params.host_session_id || params.hostSessionId);
  const context = {};
  if (hostInjectSock) context.host_inject_sock = hostInjectSock;
  if (hostDaemonSock) context.host_daemon_sock = hostDaemonSock;
  if (hostName) context.host_name = hostName;
  if (hostSessionId) context.host_session_id = hostSessionId;
  if (params.host_capabilities && typeof params.host_capabilities === "object") {
    context.host_capabilities = { ...params.host_capabilities };
  } else if (params.hostCapabilities && typeof params.hostCapabilities === "object") {
    context.host_capabilities = { ...params.hostCapabilities };
  }
  return context;
}

function buildRelationshipMaps(templateDoc = {}, plan = []) {
  const upstream = new Map();
  const downstream = new Map();

  for (const item of plan) {
    upstream.set(item.nickname, new Set([...item.depends_on, ...item.accept_from]));
    downstream.set(item.nickname, new Set(item.report_to));
  }

  const edges = Array.isArray(templateDoc.edges) ? templateDoc.edges : [];
  for (const edge of edges) {
    const from = asTrimmedString(edge && edge.from);
    const to = asTrimmedString(edge && edge.to);
    if (!from || !to) continue;
    if (!downstream.has(from)) downstream.set(from, new Set());
    if (!upstream.has(to)) upstream.set(to, new Set());
    downstream.get(from).add(to);
    upstream.get(to).add(from);
  }

  const nicknameOrder = new Map(plan.map((item, index) => [item.nickname, index]));
  const byNickname = new Map();
  for (const item of plan) {
    const orderedUpstream = Array.from(upstream.get(item.nickname) || [])
      .filter((nickname) => nicknameOrder.has(nickname))
      .sort((a, b) => nicknameOrder.get(a) - nicknameOrder.get(b));
    const orderedDownstream = Array.from(downstream.get(item.nickname) || [])
      .filter((nickname) => nicknameOrder.has(nickname))
      .sort((a, b) => nicknameOrder.get(a) - nicknameOrder.get(b));
    byNickname.set(item.nickname, {
      upstream: orderedUpstream,
      downstream: orderedDownstream,
    });
  }
  return byNickname;
}

function pickRosterMembers(roster = [], nicknames = []) {
  const wanted = new Set(Array.isArray(nicknames) ? nicknames : []);
  return roster.filter((item) => wanted.has(item.nickname));
}

function resolveAutoAgentType(projectRoot, requestedType) {
  const normalizedRequested = asTrimmedString(requestedType);
  if (normalizedRequested && normalizedRequested !== "auto") return normalizedRequested;

  const provider = asTrimmedString(loadConfig(projectRoot).agentProvider);
  if (provider === "claude-cli") return "claude";
  if (provider === "ucode") return "ucode";
  return "codex";
}

function buildExecutionPlan({
  projectRoot,
  groupId,
  templateEntry,
  templateDoc,
  plan,
  promptRegistry,
  promptProfiles,
}) {
  const profileByNickname = new Map();
  for (const item of promptProfiles || []) {
    if (item && item.nickname) profileByNickname.set(item.nickname, item);
  }

  const registryById = promptRegistry && promptRegistry.byId ? promptRegistry.byId : new Map();
  const relationships = buildRelationshipMaps(templateDoc, plan);

  const roster = plan.map((item) => {
    const resolvedType = resolveAutoAgentType(projectRoot, item.requested_type || item.type);
    const profile = profileByNickname.get(item.nickname) || null;
    return {
      nickname: item.nickname,
      requested_type: item.requested_type || item.type,
      type: resolvedType,
      role: item.role,
      prompt_profile: item.prompt_profile,
      resolved_profile: profile ? profile.resolved_profile : "",
      display_name: profile ? profile.display_name : "",
      short_name: profile ? profile.short_name : "",
      profile_source: profile ? profile.profile_source : "",
      deprecated: profile ? profile.deprecated === true : false,
      depends_on: item.depends_on.slice(),
      accept_from: item.accept_from.slice(),
      report_to: item.report_to.slice(),
    };
  });

  const rosterVersion = computeRosterVersion(roster);
  const templateInfo = templateEntry && templateEntry.data && templateEntry.data.template
    ? templateEntry.data.template
    : {};

  const executionPlan = plan.map((item) => {
    const resolvedType = resolveAutoAgentType(projectRoot, item.requested_type || item.type);
    const profile = profileByNickname.get(item.nickname) || null;
    const resolvedProfile = profile ? registryById.get(profile.resolved_profile) || null : null;
    const relation = relationships.get(item.nickname) || { upstream: [], downstream: [] };
    const upstream = pickRosterMembers(roster, relation.upstream);
    const downstream = pickRosterMembers(roster, relation.downstream);
    const metadata = buildGroupPromptMetadata({
      groupId,
      templateAlias: templateEntry.alias || asTrimmedString(templateInfo.alias),
      templateName: asTrimmedString(templateInfo.name),
      rosterVersion,
      member: {
        nickname: item.nickname,
        role: item.role,
        prompt_profile: item.prompt_profile,
        resolved_profile: profile ? profile.resolved_profile : "",
        depends_on: item.depends_on,
        accept_from: item.accept_from,
        report_to: item.report_to,
      },
      groupMembers: roster,
      upstream,
      downstream,
    });
    const bootstrapRequired = Boolean(resolvedProfile && resolvedProfile.prompt);
    const bootstrapStrategy = !bootstrapRequired
      ? "none"
      : (resolvedType === "ucode" ? "ucode-bootstrap-file" : "post-launch-inject");
    const bootstrapPrompt = bootstrapRequired
      ? composeGroupBootstrapPrompt({
        profilePrompt: resolvedProfile.prompt,
        metadata,
      })
      : "";
    const bootstrapFingerprint = bootstrapRequired
      ? computeBootstrapFingerprint({
        groupId,
        nickname: item.nickname,
        resolvedProfile: profile ? profile.resolved_profile : "",
        rosterVersion,
        promptText: bootstrapPrompt,
        metadata,
      })
      : "";

    return {
      ...item,
      requested_type: item.requested_type || item.type,
      type: resolvedType,
      resolved_profile: profile ? profile.resolved_profile : "",
      display_name: profile ? profile.display_name : "",
      short_name: profile ? profile.short_name : "",
      profile_source: profile ? profile.profile_source : "",
      deprecated: profile ? profile.deprecated === true : false,
      bootstrap_required: bootstrapRequired,
      bootstrap_strategy: bootstrapStrategy,
      bootstrap_metadata: metadata,
      bootstrap_prompt: bootstrapPrompt,
      bootstrap_fingerprint: bootstrapFingerprint,
      bootstrap_file: bootstrapStrategy === "ucode-bootstrap-file"
        ? memberBootstrapFilePath(projectRoot, groupId, item.nickname)
        : "",
      upstream: relation.upstream.slice(),
      downstream: relation.downstream.slice(),
    };
  });

  return {
    roster,
    rosterVersion,
    executionPlan,
  };
}

function buildDefaultRuntime({
  groupId,
  instance,
  templateEntry,
  plan,
  rosterVersion,
}) {
  const templateInfo = templateEntry && templateEntry.data && templateEntry.data.template
    ? templateEntry.data.template
    : {};
  const createdAt = nowIso();
  return {
    group_id: groupId,
    instance: instance || "",
    status: "starting",
    template_alias: templateEntry.alias || asTrimmedString(templateInfo.alias),
    template_id: asTrimmedString(templateInfo.id),
    template_name: asTrimmedString(templateInfo.name),
    template_version: Number.isInteger(templateEntry.schemaVersion) ? templateEntry.schemaVersion : null,
    template_source: templateEntry.source || "",
    template_file: templateEntry.filePath || "",
    roster_version: rosterVersion || "",
    created_at: createdAt,
    started_at: createdAt,
    updated_at: createdAt,
    errors: [],
    members: plan.map((item, idx) => ({
      index: idx,
      template_agent_id: item.id || "",
      nickname: item.nickname,
      requested_type: item.requested_type || item.type,
      type: item.type,
      role: item.role || "",
      prompt_profile: item.prompt_profile || "",
      resolved_profile: item.resolved_profile || "",
      display_name: item.display_name || "",
      short_name: item.short_name || "",
      profile_source: item.profile_source || "",
      profile_deprecated: item.deprecated === true,
      startup_order: item.startup_order,
      depends_on: item.depends_on.slice(),
      accept_from: item.accept_from.slice(),
      report_to: item.report_to.slice(),
      upstream: item.upstream.slice(),
      downstream: item.downstream.slice(),
      bootstrap_required: item.bootstrap_required === true,
      bootstrap_strategy: item.bootstrap_strategy || "none",
      bootstrap_status: item.bootstrap_required ? "pending" : "skipped",
      bootstrap_attempted_at: "",
      bootstrap_error: "",
      bootstrapped_subscriber_id: "",
      bootstrap_fingerprint: item.bootstrap_fingerprint || "",
      bootstrap_file: item.bootstrap_file || "",
      status: "pending",
      managed: true,
      subscriber_id: "",
      launched_at: "",
      stopped_at: "",
      launch: {},
      stop: {},
    })),
  };
}

function pickLaunchSubscriber(projectRoot, launchResult, nickname) {
  if (launchResult && Array.isArray(launchResult.subscriber_ids) && launchResult.subscriber_ids.length > 0) {
    return String(launchResult.subscriber_ids[0] || "").trim();
  }
  if (launchResult && typeof launchResult.agent_id === "string" && launchResult.agent_id.includes(":")) {
    return launchResult.agent_id;
  }
  return resolveActiveSubscriberByNickname(projectRoot, nickname);
}

function findAppliedBootstrapRecord(projectRoot, subscriberId, fingerprint, currentGroupId = "") {
  const targetSubscriber = asTrimmedString(subscriberId);
  const targetFingerprint = asTrimmedString(fingerprint);
  if (!targetSubscriber || !targetFingerprint) return null;

  const groups = listGroupStates(projectRoot);
  for (const runtime of groups) {
    if (!runtime || runtime.group_id === currentGroupId) continue;
    const members = Array.isArray(runtime.members) ? runtime.members : [];
    for (const member of members) {
      if (!member) continue;
      if (asTrimmedString(member.bootstrapped_subscriber_id) !== targetSubscriber) continue;
      if (asTrimmedString(member.bootstrap_fingerprint) !== targetFingerprint) continue;
      if (asTrimmedString(member.bootstrap_status) !== "applied") continue;
      return {
        group_id: asTrimmedString(runtime.group_id),
        nickname: asTrimmedString(member.nickname),
        bootstrap_attempted_at: asTrimmedString(member.bootstrap_attempted_at),
        bootstrapped_subscriber_id: targetSubscriber,
        bootstrap_fingerprint: targetFingerprint,
      };
    }
  }
  return null;
}

function canReuseBootstrappedMember(member, item, subscriberId) {
  return Boolean(
    member
    && member.bootstrap_status === "applied"
    && asTrimmedString(member.bootstrapped_subscriber_id) === asTrimmedString(subscriberId)
    && asTrimmedString(member.bootstrap_fingerprint) === asTrimmedString(item.bootstrap_fingerprint)
  );
}

function readAgentMeta(projectRoot, subscriberId) {
  const targetSubscriber = asTrimmedString(subscriberId);
  if (!targetSubscriber) return null;
  const agents = readBusAgents(projectRoot);
  const meta = agents[targetSubscriber];
  return meta && typeof meta === "object" ? meta : null;
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function isBootstrapReadyState(activityState = "") {
  const normalized = asTrimmedString(activityState).toLowerCase();
  return normalized === "ready"
    || normalized === "idle"
    || normalized === "waiting_input"
    || normalized === "blocked";
}

async function waitForBootstrapReady(
  projectRoot,
  subscriberId,
  {
    timeoutMs = 15000,
    retryDelayMs = 250,
    protectionMs = 3000,
    workingGraceMs = 10000,
  } = {}
) {
  const targetSubscriber = asTrimmedString(subscriberId);
  if (!targetSubscriber) {
    return { ok: false, error: "missing subscriber_id for bootstrap readiness" };
  }

  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastState = "";
  let lastStatus = "";
  while (Date.now() < deadline) {
    const meta = readAgentMeta(projectRoot, targetSubscriber);
    const status = asTrimmedString(meta && meta.status).toLowerCase();
    const activityState = asTrimmedString(meta && meta.activity_state);
    lastStatus = status || lastStatus;
    lastState = activityState || lastState;

    if (!meta && lastStatus) {
      return { ok: false, error: "agent disappeared before bootstrap" };
    }
    if (status && status !== "active") {
      return { ok: false, error: `agent became ${status} before bootstrap` };
    }
    if (isBootstrapReadyState(activityState)) {
      return { ok: true, activity_state: activityState.toLowerCase() };
    }

    const elapsedMs = Date.now() - startedAt;
    const normalizedState = activityState.toLowerCase();
    if (normalizedState === "working" && elapsedMs >= protectionMs) {
      const activitySinceMs = parseTimestampMs(meta && meta.activity_since);
      const workingMs = Number.isFinite(activitySinceMs)
        ? Math.max(0, Date.now() - activitySinceMs)
        : elapsedMs;
      if (workingMs >= workingGraceMs) {
        return {
          ok: true,
          activity_state: "working",
          degraded: true,
        };
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(retryDelayMs);
  }

  return {
    ok: false,
    error: lastState
      ? `agent not ready for bootstrap (last activity_state=${lastState})`
      : "agent not ready for bootstrap",
  };
}

async function injectBootstrapPrompt(bus, subscriberId, promptText, timeoutMs = 15000, retryDelayMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await bus.inject(subscriberId, promptText);
      return { ok: true };
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs);
    }
  }
  return {
    ok: false,
    error: lastError && lastError.message
      ? lastError.message
      : `bootstrap inject failed for ${subscriberId}`,
  };
}

function createGroupOrchestrator(options = {}) {
  const {
    projectRoot,
    handleOps,
    processManager = null,
    templatesOptions = {},
    promptProfilesOptions = {},
    bootstrapTimeoutMs = 15000,
    bootstrapRetryDelayMs = 250,
    bootstrapProtectionMs = 3000,
    bootstrapWorkingGraceMs = 10000,
  } = options;

  if (!projectRoot) {
    throw new Error("createGroupOrchestrator requires projectRoot");
  }
  if (typeof handleOps !== "function") {
    throw new Error("createGroupOrchestrator requires handleOps");
  }

  function generateGroupId(alias, instance) {
    const normalizedInstance = normalizeInstanceId(instance);
    if (normalizedInstance) return normalizedInstance;

    const prefix = normalizeInstanceId(alias) || "group";
    for (let i = 0; i < 5; i += 1) {
      const candidate = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      if (!fs.existsSync(groupFilePath(projectRoot, candidate))) {
        return candidate;
      }
    }
    return `${prefix}-${Date.now().toString(36)}`;
  }

  function validateTemplateTarget(target, resolveOptions = {}) {
    return validateGroupTemplateTarget(projectRoot, target, {
      templatesOptions,
      promptProfilesOptions,
      allowPath: resolveOptions.allowPath !== false,
    });
  }

  async function rollbackMembers(runtime, rollbackTargets = []) {
    for (let j = rollbackTargets.length - 1; j >= 0; j -= 1) {
      const target = rollbackTargets[j];
      // eslint-disable-next-line no-await-in-loop
      const closeResults = await handleOps(projectRoot, [{ action: "close", agent_id: target.target }], processManager);
      const closeResult = Array.isArray(closeResults)
        ? closeResults.find((entry) => entry && entry.action === "close")
        : null;
      const targetMember = runtime.members[target.memberIndex];
      if (closeResult && closeResult.ok !== false) {
        targetMember.status = "rolled_back";
        targetMember.stop = { ok: true, reason: "rollback", at: nowIso() };
      } else {
        targetMember.status = "rollback_failed";
        targetMember.stop = {
          ok: false,
          reason: "rollback",
          at: nowIso(),
          error: closeResult?.error || "close failed",
        };
        runtime.errors.push({
          stage: "rollback",
          nickname: targetMember.nickname,
          error: closeResult?.error || "close failed",
        });
      }
    }
  }

  async function failGroupLaunch(runtime, rollbackTargets, stage, nickname, error) {
    runtime.status = "failed";
    runtime.updated_at = nowIso();
    runtime.errors.push({ stage, nickname, error });
    await rollbackMembers(runtime, rollbackTargets);
    writeGroupState(projectRoot, runtime);
    return {
      ok: false,
      status: runtime.status,
      group_id: runtime.group_id,
      error,
      group: runtime,
    };
  }

  async function runGroup(params = {}) {
    const alias = asTrimmedString(params.alias);
    const instance = asTrimmedString(params.instance);
    const dryRun = params.dry_run === true || params.dryRun === true;
    const launchHostContext = buildLaunchHostContext(params);

    if (!alias) {
      return { ok: false, error: "group run requires alias", status: "failed" };
    }

    const validated = validateTemplateTarget(alias, { allowPath: false });
    if (!validated.ok || !validated.entry) {
      return {
        ok: false,
        error: validated.error || "template validation failed",
        validationErrors: validated.errors || [],
        status: "failed",
      };
    }

    const plan = buildLaunchPlan(validated.entry.data);
    const groupId = generateGroupId(validated.entry.alias || alias, instance);

    if (instance && !normalizeInstanceId(instance)) {
      return {
        ok: false,
        error: "instance must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/",
        status: "failed",
      };
    }

    if (fs.existsSync(groupFilePath(projectRoot, groupId))) {
      return {
        ok: false,
        error: `group id already exists: ${groupId}`,
        status: "failed",
      };
    }

    const compiled = buildExecutionPlan({
      projectRoot,
      groupId,
      templateEntry: validated.entry,
      templateDoc: validated.entry.data,
      plan,
      promptRegistry: validated.promptRegistry,
      promptProfiles: validated.promptProfiles,
    });

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        status: "dry_run",
        group_id: groupId,
        template_alias: validated.entry.alias,
        roster_version: compiled.rosterVersion,
        members: compiled.executionPlan.map((item) => ({
          nickname: item.nickname,
          type: item.type,
          role: item.role,
          startup_order: item.startup_order,
          depends_on: item.depends_on.slice(),
          accept_from: item.accept_from.slice(),
          report_to: item.report_to.slice(),
          prompt_profile: item.prompt_profile,
          resolved_profile: item.resolved_profile,
          display_name: item.display_name,
          short_name: item.short_name,
          profile_source: item.profile_source,
          deprecated: item.deprecated,
          bootstrap_required: item.bootstrap_required,
          bootstrap_strategy: item.bootstrap_strategy,
          bootstrap_fingerprint: item.bootstrap_fingerprint,
          upstream: item.upstream.slice(),
          downstream: item.downstream.slice(),
          group_members: compiled.roster,
        })),
      };
    }

    const runtime = buildDefaultRuntime({
      groupId,
      instance,
      templateEntry: validated.entry,
      plan: compiled.executionPlan,
      rosterVersion: compiled.rosterVersion,
    });
    writeGroupState(projectRoot, runtime);

    const rollbackTargets = [];
    const eventBus = new EventBus(projectRoot);

    for (let i = 0; i < compiled.executionPlan.length; i += 1) {
      const item = compiled.executionPlan[i];
      const member = runtime.members[i];
      const extraEnv = {};

      if (item.bootstrap_strategy === "ucode-bootstrap-file") {
        member.bootstrap_attempted_at = nowIso();
        member.bootstrap_error = "";
        try {
          prepareUcodeBootstrap({
            projectRoot,
            targetFile: item.bootstrap_file,
            promptText: item.bootstrap_prompt,
          });
          extraEnv.UFOO_UCODE_BOOTSTRAP_FILE = item.bootstrap_file;
        } catch (err) {
          member.status = "failed";
          member.bootstrap_status = "failed";
          member.bootstrap_error = err && err.message ? err.message : "failed to prepare ucode bootstrap";
          return failGroupLaunch(
            runtime,
            rollbackTargets,
            "bootstrap",
            item.nickname,
            member.bootstrap_error
          );
        }
      }

      const op = {
        action: "launch",
        agent: item.type,
        count: 1,
        nickname: item.nickname,
        ...launchHostContext,
      };
      if (Object.keys(extraEnv).length > 0) {
        op.extra_env = extraEnv;
      }

      // eslint-disable-next-line no-await-in-loop
      const opsResults = await handleOps(projectRoot, [op], processManager);
      const launchResult = Array.isArray(opsResults)
        ? opsResults.find((entry) => entry && entry.action === "launch")
        : null;

      if (!launchResult || launchResult.ok === false) {
        member.status = "failed";
        member.launch = launchResult || {};
        return failGroupLaunch(
          runtime,
          rollbackTargets,
          "launch",
          item.nickname,
          launchResult && launchResult.error
            ? launchResult.error
            : `launch failed for ${item.nickname}`
        );
      }

      const reused = Boolean(launchResult.skipped);
      const subscriberId = pickLaunchSubscriber(projectRoot, launchResult, item.nickname);
      member.status = reused ? "reused" : "active";
      member.managed = !reused;
      member.subscriber_id = subscriberId || "";
      member.launched_at = nowIso();
      member.launch = launchResult;
      member.bootstrap_error = "";
      runtime.updated_at = nowIso();

      if (!reused) {
        rollbackTargets.push({
          memberIndex: i,
          target: subscriberId || item.nickname,
        });
      } else if (!canReuseBootstrappedMember(member, item, subscriberId)) {
        const priorBootstrap = findAppliedBootstrapRecord(
          projectRoot,
          subscriberId,
          item.bootstrap_fingerprint,
          runtime.group_id
        );
        if (priorBootstrap) {
          member.bootstrap_status = "applied";
          member.bootstrap_attempted_at = priorBootstrap.bootstrap_attempted_at || nowIso();
          member.bootstrapped_subscriber_id = priorBootstrap.bootstrapped_subscriber_id;
          member.bootstrap_fingerprint = priorBootstrap.bootstrap_fingerprint;
          member.bootstrap_error = "";
        } else if (item.bootstrap_required && item.bootstrap_strategy === "post-launch-inject" && subscriberId) {
          member.bootstrap_status = "pending";
        } else {
          member.status = "failed";
          member.bootstrap_status = "failed";
          member.bootstrap_error = `unsafe reused member "${item.nickname}": missing matching bootstrap fingerprint`;
          writeGroupState(projectRoot, runtime);
          return failGroupLaunch(
            runtime,
            rollbackTargets,
            "bootstrap",
            item.nickname,
            member.bootstrap_error
          );
        }
      }

      if (!item.bootstrap_required) {
        member.bootstrap_status = "skipped";
        writeGroupState(projectRoot, runtime);
        continue;
      }

      if (
        member.bootstrap_status === "applied"
        && asTrimmedString(member.bootstrapped_subscriber_id) === asTrimmedString(subscriberId)
        && asTrimmedString(member.bootstrap_fingerprint) === asTrimmedString(item.bootstrap_fingerprint)
      ) {
        writeGroupState(projectRoot, runtime);
        continue;
      }

      member.bootstrap_attempted_at = member.bootstrap_attempted_at || nowIso();
      if (item.bootstrap_strategy === "post-launch-inject") {
        // Wait for the agent wrapper/startup sequence to settle before injecting
        // the group bootstrap prompt, otherwise the default startup command flow
        // can be interrupted mid-boot.
        // eslint-disable-next-line no-await-in-loop
        const ready = await waitForBootstrapReady(
          projectRoot,
          subscriberId,
          {
            timeoutMs: bootstrapTimeoutMs,
            retryDelayMs: bootstrapRetryDelayMs,
            protectionMs: bootstrapProtectionMs,
            workingGraceMs: bootstrapWorkingGraceMs,
          }
        );
        if (!ready.ok) {
          member.status = "failed";
          member.bootstrap_status = "failed";
          member.bootstrap_error = ready.error || `bootstrap readiness failed for ${item.nickname}`;
          return failGroupLaunch(
            runtime,
            rollbackTargets,
            "bootstrap",
            item.nickname,
            member.bootstrap_error
          );
        }
        // eslint-disable-next-line no-await-in-loop
        const injected = await injectBootstrapPrompt(
          eventBus,
          subscriberId,
          item.bootstrap_prompt,
          bootstrapTimeoutMs,
          bootstrapRetryDelayMs
        );
        if (!injected.ok) {
          member.status = "failed";
          member.bootstrap_status = "failed";
          member.bootstrap_error = injected.error || `bootstrap inject failed for ${item.nickname}`;
          return failGroupLaunch(
            runtime,
            rollbackTargets,
            "bootstrap",
            item.nickname,
            member.bootstrap_error
          );
        }
      }

      member.bootstrap_status = "applied";
      member.bootstrapped_subscriber_id = subscriberId || "";
      member.bootstrap_fingerprint = item.bootstrap_fingerprint || "";
      member.bootstrap_error = "";
      writeGroupState(projectRoot, runtime);
    }

    runtime.status = "active";
    runtime.updated_at = nowIso();
    writeGroupState(projectRoot, runtime);

    return {
      ok: true,
      status: runtime.status,
      group_id: runtime.group_id,
      group: runtime,
    };
  }

  async function stopGroup(params = {}) {
    const requestedGroupId = asTrimmedString(params.groupId || params.group_id || "");
    if (!requestedGroupId) {
      return { ok: false, error: "stop_group requires group_id", status: "failed" };
    }
    const groupId = normalizeGroupId(requestedGroupId);
    if (!groupId || groupId !== requestedGroupId) {
      return { ok: false, error: "invalid group_id", status: "failed" };
    }

    const runtime = readGroupState(projectRoot, groupId);
    if (!runtime) {
      return { ok: false, error: `group not found: ${groupId}`, status: "failed" };
    }

    const members = Array.isArray(runtime.members) ? runtime.members : [];
    const activeMembers = [];
    for (let i = members.length - 1; i >= 0; i -= 1) {
      const member = members[i];
      if (!member || member.managed === false) continue;
      if (member.status !== "active") continue;
      const target = asTrimmedString(member.subscriber_id) || asTrimmedString(member.nickname);
      if (!target) continue;
      activeMembers.push({ index: i, target });
    }

    const errors = [];
    for (const item of activeMembers) {
      // eslint-disable-next-line no-await-in-loop
      const closeResults = await handleOps(projectRoot, [{ action: "close", agent_id: item.target }], processManager);
      const closeResult = Array.isArray(closeResults)
        ? closeResults.find((entry) => entry && entry.action === "close")
        : null;
      const member = runtime.members[item.index];
      if (closeResult && closeResult.ok !== false) {
        member.status = "stopped";
        member.stop = { ok: true, at: nowIso() };
      } else {
        member.status = "stop_failed";
        member.stop = { ok: false, at: nowIso(), error: closeResult?.error || "close failed" };
        errors.push({ nickname: member.nickname, error: closeResult?.error || "close failed" });
      }
    }

    runtime.status = "stopped";
    runtime.updated_at = nowIso();
    runtime.errors = Array.isArray(runtime.errors) ? runtime.errors : [];
    for (const err of errors) {
      runtime.errors.push({ stage: "stop", ...err });
    }
    writeGroupState(projectRoot, runtime);

    return {
      ok: true,
      status: runtime.status,
      group_id: runtime.group_id,
      errors,
      group: runtime,
    };
  }

  function getStatus(params = {}) {
    const requestedGroupId = asTrimmedString(params.groupId || params.group_id || "");
    if (requestedGroupId) {
      const groupId = normalizeGroupId(requestedGroupId);
      if (!groupId || groupId !== requestedGroupId) {
        return { ok: false, error: "invalid group_id" };
      }
      const group = readGroupState(projectRoot, groupId);
      if (!group) {
        return { ok: false, error: `group not found: ${groupId}` };
      }
      return { ok: true, group };
    }

    const groups = listGroupStates(projectRoot).map((runtime) => summarizeGroup(runtime));
    groups.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    return { ok: true, count: groups.length, groups };
  }

  return {
    validateTemplateTarget,
    runGroup,
    stopGroup,
    getStatus,
    summarizeGroup,
  };
}

module.exports = {
  createGroupOrchestrator,
  buildLaunchPlan,
  normalizeGroupId,
};
