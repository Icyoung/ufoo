"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { resolveTemplateReference } = require("../group/templates");
const { validateTemplate } = require("../group/validateTemplate");

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

const SAFE_GROUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function formatResolveErrors(errors = []) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return errors
    .map((item) => `${item.filePath}: ${item.error}`)
    .join("; ");
}

function resolveTemplateTarget(projectRoot, target, options = {}) {
  const resolved = resolveTemplateReference(projectRoot, target, {
    allowPath: options.allowPath !== false,
    cwd: options.cwd || projectRoot,
    ...(options.templatesOptions || {}),
  });

  if (resolved.entry) {
    return { ok: true, resolved, error: "" };
  }

  const details = formatResolveErrors(resolved.errors || []);
  const error = details
    ? `failed to load template "${target}": ${details}`
    : `template not found: ${target}`;
  return { ok: false, resolved, error };
}

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
    const dependsOn = Array.isArray(agent.depends_on)
      ? agent.depends_on.map((item) => asTrimmedString(item)).filter(Boolean)
      : [];
    const startupOrder = Number.isInteger(agent.startup_order) ? agent.startup_order : 0;
    remaining.set(nickname, {
      id: asTrimmedString(agent.id),
      nickname,
      type: asTrimmedString(agent.type),
      startup_order: startupOrder,
      depends_on: dependsOn,
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

function buildDefaultRuntime({
  groupId,
  instance,
  templateEntry,
  plan,
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
    created_at: createdAt,
    started_at: createdAt,
    updated_at: createdAt,
    errors: [],
    members: plan.map((item, idx) => ({
      index: idx,
      template_agent_id: item.id || "",
      nickname: item.nickname,
      type: item.type,
      startup_order: item.startup_order,
      depends_on: item.depends_on.slice(),
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

function createGroupOrchestrator(options = {}) {
  const {
    projectRoot,
    handleOps,
    processManager = null,
    templatesOptions = {},
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
    const rawTarget = asTrimmedString(target);
    if (!rawTarget) {
      return { ok: false, error: "template target is required", errors: [], entry: null };
    }
    const resolvedState = resolveTemplateTarget(projectRoot, rawTarget, {
      templatesOptions,
      allowPath: resolveOptions.allowPath !== false,
    });
    if (!resolvedState.ok) {
      return {
        ok: false,
        error: resolvedState.error,
        errors: resolvedState.resolved.errors || [],
        entry: null,
      };
    }
    const result = validateTemplate(resolvedState.resolved.entry.data);
    if (!result.ok) {
      return {
        ok: false,
        error: "template validation failed",
        errors: result.errors,
        entry: resolvedState.resolved.entry,
      };
    }
    return {
      ok: true,
      error: "",
      errors: [],
      entry: resolvedState.resolved.entry,
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

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        status: "dry_run",
        group_id: groupId,
        template_alias: validated.entry.alias,
        members: plan.map((item) => ({
          nickname: item.nickname,
          type: item.type,
          startup_order: item.startup_order,
          depends_on: item.depends_on.slice(),
        })),
      };
    }

    const runtime = buildDefaultRuntime({
      groupId,
      instance,
      templateEntry: validated.entry,
      plan,
    });
    writeGroupState(projectRoot, runtime);

    const rollbackTargets = [];

    for (let i = 0; i < plan.length; i += 1) {
      const item = plan[i];
      const member = runtime.members[i];
      const op = {
        action: "launch",
        agent: item.type,
        count: 1,
        nickname: item.nickname,
        ...launchHostContext,
      };

      // eslint-disable-next-line no-await-in-loop
      const opsResults = await handleOps(projectRoot, [op], processManager);
      const launchResult = Array.isArray(opsResults)
        ? opsResults.find((entry) => entry && entry.action === "launch")
        : null;

      if (!launchResult || launchResult.ok === false) {
        member.status = "failed";
        member.launch = launchResult || {};
        runtime.status = "failed";
        runtime.updated_at = nowIso();
        runtime.errors.push({
          stage: "launch",
          nickname: item.nickname,
          error: launchResult && launchResult.error
            ? launchResult.error
            : `launch failed for ${item.nickname}`,
        });

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
            targetMember.stop = { ok: false, reason: "rollback", at: nowIso(), error: closeResult?.error || "close failed" };
            runtime.errors.push({
              stage: "rollback",
              nickname: targetMember.nickname,
              error: closeResult?.error || "close failed",
            });
          }
        }

        writeGroupState(projectRoot, runtime);
        return {
          ok: false,
          status: runtime.status,
          group_id: runtime.group_id,
          error: runtime.errors[runtime.errors.length - 1]?.error || "group launch failed",
          group: runtime,
        };
      }

      const reused = Boolean(launchResult.skipped);
      const subscriberId = pickLaunchSubscriber(projectRoot, launchResult, item.nickname);
      member.status = reused ? "reused" : "active";
      member.managed = !reused;
      member.subscriber_id = subscriberId || "";
      member.launched_at = nowIso();
      member.launch = launchResult;
      runtime.updated_at = nowIso();

      if (!reused) {
        rollbackTargets.push({
          memberIndex: i,
          target: subscriberId || item.nickname,
        });
      }

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
