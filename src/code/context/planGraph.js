"use strict";

/**
 * Unified Execution Plan IR + graph engine.
 *
 * High-level nodes (task / tool / group / checkpoint) compile down to a flat
 * executable graph. Group strategy is sugar over dependsOn. Runtime executes
 * tool nodes; task/checkpoint yield control back to the LLM.
 */

const { randomUUID } = require("crypto");
const {
  recoverExpiredLeases,
  claimSafeReadyToolBatch,
} = require("./toolRuntime");

const NODE_TYPES = Object.freeze(["task", "tool", "group", "checkpoint"]);
const NODE_STATUSES = Object.freeze([
  "pending",
  "ready",
  "running",
  "waiting_llm",
  "waiting_approval",
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "cancelled",
]);

const DEFAULT_KNOWN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "artifact_read",
]);

const TOOL_ALIASES = Object.freeze({
  "code.read": "read",
  "code.write": "write",
  "code.edit": "edit",
  "code.patch": "edit",
  "shell.run": "bash",
  "test.run": "bash",
  "git.diff": "bash",
  "code.search": "bash",
  "code.read_matches": "read",
  "artifact.read": "artifact_read",
});

const SIDE_EFFECT_TOOLS = new Set(["write", "edit"]);
const REF_PATTERN = /\$\{([a-zA-Z0-9_-]+)((?:\.[a-zA-Z0-9_]+|\[\d+\])*)\}/g;

function createPlanId(prefix = "plan") {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function normalizeDependsOn(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeBaseNode(source = {}, fallbackId = "") {
  const id = String(source.id || fallbackId || "").trim();
  const type = String(source.type || "").trim().toLowerCase();
  return {
    id,
    type,
    dependsOn: normalizeDependsOn(source.dependsOn || source.depends_on),
    status: String(source.status || "pending").trim().toLowerCase() || "pending",
  };
}

function normalizePlanNode(source = {}, fallbackId = "node") {
  const base = normalizeBaseNode(source, fallbackId);
  if (base.type === "tool") {
    return {
      ...base,
      type: "tool",
      tool: String(source.tool || "").trim(),
      args: source.args && typeof source.args === "object" ? cloneJson(source.args) : {},
      parentTaskId: String(source.parentTaskId || "").trim(),
      createdSeq: Number.isFinite(source.createdSeq) ? Math.floor(source.createdSeq) : 0,
      generated: Boolean(source.generated),
      displayOrder: Number.isFinite(source.displayOrder) ? Math.floor(source.displayOrder) : 0,
      attempt: Number.isFinite(source.attempt) ? Math.max(0, Math.floor(source.attempt)) : 0,
    };
  }
  if (base.type === "task") {
    const title = String(source.title || "").trim();
    const objective = String(source.objective || title || "").trim();
    let execution;
    if (source.execution && typeof source.execution === "object" && !Array.isArray(source.execution)) {
      const kindRaw = String(source.execution.kind || "inline_llm").trim().toLowerCase();
      let kind = "inline_llm";
      if (kindRaw === "llm") kind = "inline_llm";
      else if (kindRaw === "inline_llm") kind = "inline_llm";
      else if (kindRaw === "expand") kind = "expand";
      else if (kindRaw === "aggregate") kind = "aggregate";
      else if (kindRaw === "task_loop") kind = "task_loop";
      else kind = kindRaw || "inline_llm";
      execution = { ...cloneJson(source.execution), kind };
      // Illegal combinations: expand/inline_llm must not carry workspace/merge
      if (kind !== "task_loop") {
        delete execution.workspace;
        delete execution.completion;
        delete execution.acceptance;
      }
    } else {
      const rawExec = String(source.execution || "llm").trim().toLowerCase();
      let kind = "inline_llm";
      if (rawExec === "expand") kind = "expand";
      else if (rawExec === "aggregate") kind = "aggregate";
      else if (rawExec === "task_loop") kind = "task_loop";
      else if (rawExec === "inline_llm" || rawExec === "llm" || !rawExec) kind = "inline_llm";
      execution = { kind };
    }
    return {
      ...base,
      type: "task",
      title: title || objective,
      objective,
      successCriteria: Array.isArray(source.successCriteria)
        ? source.successCriteria.map(String)
        : (Array.isArray(source.success_criteria) ? source.success_criteria.map(String) : []),
      execution,
      inputs: source.inputs && typeof source.inputs === "object" ? cloneJson(source.inputs) : {},
      parentTaskId: String(source.parentTaskId || "").trim(),
      createdSeq: Number.isFinite(source.createdSeq) ? Math.floor(source.createdSeq) : 0,
      generated: Boolean(source.generated),
      displayOrder: Number.isFinite(source.displayOrder) ? Math.floor(source.displayOrder) : 0,
      attempt: Number.isFinite(source.attempt) ? Math.max(0, Math.floor(source.attempt)) : 0,
      runtime: source.runtime && typeof source.runtime === "object" ? cloneJson(source.runtime) : undefined,
    };
  }
  if (base.type === "checkpoint") {
    return {
      ...base,
      type: "checkpoint",
      mode: String(source.mode || "llm").trim().toLowerCase() === "approval"
        ? "approval"
        : "llm",
      reason: String(source.reason || "").trim(),
      stopKind: String(source.stopKind || "checkpoint").trim() || "checkpoint",
    };
  }
  if (base.type === "group") {
    const strategy = String(source.strategy || "sequence").trim().toLowerCase() === "parallel"
      ? "parallel"
      : "sequence";
    const childrenSource = Array.isArray(source.children) ? source.children : [];
    return {
      ...base,
      type: "group",
      strategy,
      children: childrenSource.map((child, index) => (
        normalizePlanNode(child, `${base.id || fallbackId}_c${index + 1}`)
      )),
    };
  }
  if (source.tool) {
    return {
      ...base,
      type: "tool",
      id: base.id || fallbackId,
      tool: String(source.tool || "").trim(),
      args: source.args && typeof source.args === "object" ? cloneJson(source.args) : {},
    };
  }
  return {
    ...base,
    type: base.type || "task",
    title: String(source.title || source.objective || source.goal || "").trim(),
    objective: String(source.objective || source.title || source.goal || "").trim(),
    execution: "llm",
    successCriteria: [],
    inputs: {},
  };
}

function normalizePlanGraph(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const failurePolicy = String(source.failurePolicy || "continue_independent").trim().toLowerCase() === "fail_fast"
    ? "fail_fast"
    : "continue_independent";
  if (Array.isArray(source.nodes)) {
    return {
      id: String(source.id || createPlanId("plan")).trim(),
      objective: String(source.objective || "").trim(),
      failurePolicy,
      nodes: source.nodes.map((node, index) => normalizePlanNode(node, `n${index + 1}`)),
    };
  }
  if (source.type === "group" || Array.isArray(source.children)) {
    const root = normalizePlanNode({ ...source, type: "group" }, "root");
    return {
      id: String(source.id || createPlanId("plan")).trim(),
      objective: String(source.objective || "").trim(),
      failurePolicy,
      nodes: [root],
    };
  }
  if (Array.isArray(source.steps)) {
    const segmentGraph = planGraphFromExecutionSegment(source);
    return { ...segmentGraph, failurePolicy };
  }
  if (source.type || source.tool || source.objective) {
    return {
      id: String(source.id || createPlanId("plan")).trim(),
      objective: String(source.objective || "").trim(),
      failurePolicy,
      nodes: [normalizePlanNode(source, "n1")],
    };
  }
  return { id: createPlanId("plan"), objective: "", failurePolicy, nodes: [] };
}

function planGraphFromExecutionSegment(segment = {}) {
  const source = segment && typeof segment === "object" ? segment : {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const checkpointAfter = new Set(
    Array.isArray(source.checkpoint && source.checkpoint.after)
      ? source.checkpoint.after.map(String)
      : [],
  );
  const nodes = steps.map((step, index) => normalizePlanNode({
    ...step,
    type: "tool",
    id: step.id || `s${index + 1}`,
  }, `s${index + 1}`));

  // Legacy segments run in array order; chain adjacent steps unless already dependent.
  const expanded = [];
  let previousId = null;
  for (const node of nodes) {
    const deps = normalizeDependsOn(node.dependsOn);
    if (previousId && !deps.includes(previousId)) deps.push(previousId);
    const toolNode = { ...node, dependsOn: deps };
    expanded.push(toolNode);
    previousId = toolNode.id;

    if (checkpointAfter.has(toolNode.id)) {
      const checkpoint = {
        id: `${toolNode.id}__checkpoint`,
        type: "checkpoint",
        mode: "llm",
        reason: `checkpoint after ${toolNode.id}`,
        dependsOn: [toolNode.id],
        status: "pending",
        stopKind: "checkpoint",
      };
      expanded.push(checkpoint);
      previousId = checkpoint.id;
    } else if (SIDE_EFFECT_TOOLS.has(String(toolNode.tool || "").toLowerCase())) {
      const checkpoint = {
        id: `${toolNode.id}__side_effect_gate`,
        type: "checkpoint",
        mode: "llm",
        reason: `side-effect tool ${toolNode.tool} requires review`,
        dependsOn: [toolNode.id],
        status: "pending",
        stopKind: "side_effect",
      };
      expanded.push(checkpoint);
      previousId = checkpoint.id;
    }
  }

  return {
    id: String(source.id || createPlanId("seg")).trim(),
    objective: String(source.objective || "").trim(),
    failurePolicy: String(source.failurePolicy || "continue_independent").trim().toLowerCase() === "fail_fast"
      ? "fail_fast"
      : "continue_independent",
    nodes: expanded,
  };
}

function collectRefsFromValue(value, out = new Set()) {
  if (typeof value === "string") {
    REF_PATTERN.lastIndex = 0;
    let match = REF_PATTERN.exec(value);
    while (match) {
      out.add(match[1]);
      match = REF_PATTERN.exec(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefsFromValue(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    if (value.$ref && typeof value.$ref === "object") {
      const nodeId = String(value.$ref.node || value.$ref.nodeId || "").trim();
      if (nodeId) out.add(nodeId);
      return out;
    }
    if (value.$template != null) {
      collectRefsFromValue(value.$template, out);
      return out;
    }
    for (const item of Object.values(value)) collectRefsFromValue(item, out);
  }
  return out;
}

function resolveToolName(tool = "") {
  const raw = String(tool || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower];
  return raw;
}

function flattenPlanNodes(nodes = [], parentDependsOn = [], {
  sequential = false,
  groupSinks = null,
} = {}) {
  const out = [];
  const sinks = groupSinks || new Map();
  const list = Array.isArray(nodes) ? nodes : [];
  let previousInSequence = null;

  for (const node of list) {
    if (!node || typeof node !== "object") continue;
    if (node.type === "group") {
      const childDepends = parentDependsOn.slice();
      if (sequential && previousInSequence) childDepends.push(previousInSequence);
      const startIndex = out.length;
      if (node.strategy === "sequence") {
        let seqPrev = null;
        for (const child of node.children || []) {
          const deps = normalizeDependsOn(child.dependsOn).concat(childDepends);
          if (seqPrev) deps.push(seqPrev);
          const flattened = flattenPlanNodes(
            [{ ...child, dependsOn: deps }],
            [],
            { sequential: false, groupSinks: sinks },
          );
          const leaves = Array.isArray(flattened) ? flattened : flattened.nodes;
          out.push(...leaves);
          if (leaves.length > 0) seqPrev = leaves[leaves.length - 1].id;
        }
        const groupLeaves = out.slice(startIndex);
        if (node.id) {
          sinks.set(
            node.id,
            groupLeaves.length > 0 ? [groupLeaves[groupLeaves.length - 1].id] : [],
          );
        }
        previousInSequence = sequential
          ? (groupLeaves.length > 0 ? groupLeaves[groupLeaves.length - 1].id : previousInSequence)
          : null;
      } else {
        const parallelLeaves = [];
        for (const child of node.children || []) {
          const deps = normalizeDependsOn(child.dependsOn).concat(childDepends);
          const flattened = flattenPlanNodes(
            [{ ...child, dependsOn: deps }],
            [],
            { sequential: false, groupSinks: sinks },
          );
          const leaves = Array.isArray(flattened) ? flattened : flattened.nodes;
          out.push(...leaves);
          for (const leaf of leaves) parallelLeaves.push(leaf.id);
        }
        if (node.id) sinks.set(node.id, parallelLeaves.slice());
        previousInSequence = null;
      }
      continue;
    }

    const deps = normalizeDependsOn(node.dependsOn).concat(parentDependsOn);
    if (sequential && previousInSequence) deps.push(previousInSequence);
    out.push({
      ...node,
      dependsOn: Array.from(new Set(deps)),
    });
    previousInSequence = node.id;
  }

  if (groupSinks) return out;
  return { nodes: out, groupSinks: sinks };
}

function rewriteGroupDependencies(nodes = [], groupSinks = new Map()) {
  if (!groupSinks || groupSinks.size === 0) return nodes;
  return nodes.map((node) => {
    const nextDeps = [];
    for (const dep of normalizeDependsOn(node.dependsOn)) {
      if (groupSinks.has(dep)) {
        nextDeps.push(...groupSinks.get(dep));
      } else {
        nextDeps.push(dep);
      }
    }
    return {
      ...node,
      dependsOn: Array.from(new Set(nextDeps)),
    };
  });
}

function detectCycles(nodes = []) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visited.has(id)) return null;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return stack.slice(start >= 0 ? start : 0).concat([id]);
    }
    visiting.add(id);
    stack.push(id);
    const node = byId.get(id);
    for (const dep of (node && node.dependsOn) || []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

function compilePlanGraph(input = {}, options = {}) {
  const knownTools = options.knownTools instanceof Set
    ? options.knownTools
    : new Set([
      ...DEFAULT_KNOWN_TOOLS,
      ...(Array.isArray(options.knownTools) ? options.knownTools.map((t) => String(t).toLowerCase()) : []),
    ]);
  const plan = normalizePlanGraph(input);
  const errors = [];
  const warnings = [];
  const flatResult = flattenPlanNodes(plan.nodes);
  const flattened = rewriteGroupDependencies(flatResult.nodes, flatResult.groupSinks);
  const byId = new Map();

  for (const node of flattened) {
    if (!node.id) {
      errors.push("node missing id");
      continue;
    }
    if (byId.has(node.id)) {
      errors.push(`duplicate node id: ${node.id}`);
      continue;
    }
    byId.set(node.id, {
      ...node,
      dependsOn: normalizeDependsOn(node.dependsOn),
      status: "pending",
    });
  }

  for (const node of byId.values()) {
    const refs = new Set();
    collectRefsFromValue(node.args, refs);
    collectRefsFromValue(node.inputs, refs);
    for (const ref of refs) {
      if (ref === node.id) {
        errors.push(`node ${node.id} references itself`);
        continue;
      }
      if (!byId.has(ref)) {
        errors.push(`node ${node.id} references unknown node ${ref}`);
        continue;
      }
      if (!node.dependsOn.includes(ref)) {
        node.dependsOn.push(ref);
        warnings.push(`inferred dependsOn ${ref} for ${node.id}`);
      }
    }
  }

  for (const node of byId.values()) {
    if (node.type !== "tool") continue;
    const resolved = resolveToolName(node.tool);
    if (!resolved) {
      errors.push(`tool node ${node.id} missing tool`);
      continue;
    }
    node.tool = resolved;
    if (knownTools.size > 0 && !knownTools.has(resolved.toLowerCase())) {
      warnings.push(`unknown tool ${resolved} on node ${node.id}`);
    }
  }

  for (const node of byId.values()) {
    node.dependsOn = node.dependsOn.filter((dep) => {
      if (byId.has(dep)) return true;
      errors.push(`node ${node.id} depends on missing node ${dep}`);
      return false;
    });
  }

  const executableNodes = Array.from(byId.values());
  const cycle = detectCycles(executableNodes);
  if (cycle) errors.push(`cycle detected: ${cycle.join(" -> ")}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    planId: plan.id,
    objective: plan.objective,
    failurePolicy: plan.failurePolicy || "continue_independent",
    nodes: executableNodes,
    nodeMap: byId,
  };
}

function getPathValue(root, pathExpr = "") {
  if (!pathExpr) return root;
  const tokens = [];
  const re = /\.([a-zA-Z0-9_]+)|\[(\d+)\]/g;
  let match = re.exec(pathExpr);
  while (match) {
    tokens.push(match[1] != null ? match[1] : Number(match[2]));
    match = re.exec(pathExpr);
  }
  let cur = root;
  for (const token of tokens) {
    if (cur == null) return undefined;
    cur = cur[token];
  }
  return cur;
}

function resolveRefToken(token, outputs = new Map()) {
  const match = String(token || "").match(/^([a-zA-Z0-9_-]+)((?:\.[a-zA-Z0-9_]+|\[\d+\])*)$/);
  if (!match) return undefined;
  const nodeId = match[1];
  const pathExpr = match[2] || "";
  const record = outputs.get(nodeId);
  if (!record) return undefined;
  if (!pathExpr) return record;
  return getPathValue(record, pathExpr);
}

function resolveTemplateString(text = "", outputs = new Map()) {
  const source = String(text || "");
  const full = source.match(/^\$\{([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_]+|\[\d+\])*)\}$/);
  if (full) return resolveRefToken(full[1], outputs);
  return source.replace(REF_PATTERN, (_, nodeId, pathExpr = "") => {
    const value = resolveRefToken(`${nodeId}${pathExpr || ""}`, outputs);
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
  });
}

function resolveStructuredRef(ref = {}, outputs = new Map()) {
  const nodeId = String(ref.node || ref.nodeId || "").trim();
  if (!nodeId) return undefined;
  const record = outputs.get(nodeId);
  if (!record) return undefined;
  const pointer = String(ref.pointer || "").trim();
  if (!pointer || pointer === "/") return record;
  // JSON pointer-ish: /output/field or /summary
  const pathExpr = pointer
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((part) => ( /^\d+$/.test(part) ? `[${part}]` : `.${part}` ))
    .join("");
  return getPathValue(record, pathExpr);
}

function resolveValue(value, outputs = new Map()) {
  if (typeof value === "string") return resolveTemplateString(value, outputs);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, outputs));
  if (value && typeof value === "object") {
    if (value.$ref && typeof value.$ref === "object") {
      return resolveStructuredRef(value.$ref, outputs);
    }
    if (Object.prototype.hasOwnProperty.call(value, "$template")) {
      const template = value.$template;
      if (typeof template === "string") return resolveTemplateString(template, outputs);
      return resolveValue(template, outputs);
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, outputs);
    return out;
  }
  return value;
}

function normalizeNodeResult(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const ok = source.ok !== false && source.status !== "failed";
  return {
    status: ok ? "succeeded" : "failed",
    output: source.output != null
      ? source.output
      : (source.result != null ? source.result : (ok ? source : {})),
    artifacts: Array.isArray(source.artifacts)
      ? source.artifacts
      : (source.artifactId ? [{ id: source.artifactId }] : []),
    summary: String(source.summary || "").trim(),
    error: String(source.error || "").trim(),
    artifactId: String(
      source.artifactId
      || (source.artifacts && source.artifacts[0] && source.artifacts[0].id)
      || "",
    ).trim(),
    raw: source,
  };
}

function compareNodeOrder(a, b) {
  const seqA = Number.isFinite(a.createdSeq) ? a.createdSeq : 0;
  const seqB = Number.isFinite(b.createdSeq) ? b.createdSeq : 0;
  if (seqA !== seqB) return seqA - seqB;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function getReadyNodes(nodeMap = new Map()) {
  const ready = [];
  for (const node of nodeMap.values()) {
    if (node.status !== "pending") continue;
    const deps = normalizeDependsOn(node.dependsOn);
    const allSucceeded = deps.every((depId) => {
      const dep = nodeMap.get(depId);
      return dep && dep.status === "succeeded";
    });
    if (allSucceeded) ready.push(node);
  }
  ready.sort(compareNodeOrder);
  return ready;
}

function getTaskExecutionKind(node = null) {
  if (!node || node.type !== "task") return "";
  const exec = node.execution;
  if (exec && typeof exec === "object") {
    return String(exec.kind || "").trim().toLowerCase() || "inline_llm";
  }
  const raw = String(exec || "llm").trim().toLowerCase();
  if (raw === "aggregate") return "aggregate";
  if (raw === "expand") return "expand";
  if (raw === "task_loop") return "task_loop";
  if (raw === "inline_llm") return "inline_llm";
  return raw === "llm" || !raw ? "inline_llm" : raw;
}

function isAggregateTask(node = null) {
  return Boolean(node && node.type === "task" && getTaskExecutionKind(node) === "aggregate");
}

function isLlmControlNode(node = null) {
  if (!node) return false;
  if (node.type === "checkpoint") return true;
  if (node.type === "task" && !isAggregateTask(node)) {
    // task_loop nodes stay ready for Agent start_task; they do not yield waiting_llm.
    if (getTaskExecutionKind(node) === "task_loop") return false;
    return true;
  }
  return false;
}

function isTaskLoopNode(node = null) {
  return Boolean(node && node.type === "task" && getTaskExecutionKind(node) === "task_loop");
}

function blockDependents(nodeMap, failedId) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodeMap.values()) {
      if (node.status !== "pending") continue;
      const blocked = normalizeDependsOn(node.dependsOn).some((depId) => {
        const dep = nodeMap.get(depId);
        return dep && (dep.status === "failed" || dep.status === "blocked" || dep.status === "skipped" || dep.status === "cancelled");
      });
      if (blocked) {
        node.status = "blocked";
        node.error = `blocked by ${failedId}`;
        changed = true;
      }
    }
  }
}

function isTerminal(nodeMap = new Map()) {
  for (const node of nodeMap.values()) {
    if (
      node.status === "pending"
      || node.status === "ready"
      || node.status === "running"
      || node.status === "waiting_llm"
      || node.status === "waiting_approval"
    ) return false;
  }
  return true;
}

function summarizeGraph(nodeMap = new Map(), meta = {}) {
  const nodes = {};
  const nodeSummaries = [];
  let succeeded = 0;
  let failed = 0;
  for (const node of nodeMap.values()) {
    nodes[node.id] = {
      status: node.status,
      type: node.type,
      tool: node.tool || "",
      error: node.error || "",
    };
    if (node.status === "succeeded") succeeded += 1;
    if (node.status === "failed") failed += 1;
    if (node.result) {
      nodeSummaries.push({
        id: node.id,
        type: node.type,
        status: node.status,
        summary: node.result.summary || "",
        artifact: node.result.artifactId ? `artifact://${node.result.artifactId}` : "",
      });
    } else if (node.status === "failed" || node.status === "blocked") {
      nodeSummaries.push({
        id: node.id,
        type: node.type,
        status: node.status,
        summary: node.error || node.status,
        artifact: "",
      });
    }
  }
  let status = "success";
  if (failed > 0 && succeeded > 0) status = "partial_failure";
  else if (failed > 0 && succeeded === 0) status = "failed";
  else if (
    meta.stoppedAt === "checkpoint"
    || meta.stoppedAt === "side_effect"
    || meta.stoppedAt === "waiting_llm"
  ) status = "checkpoint";

  return {
    planId: meta.planId || "",
    segment_id: meta.planId || "",
    status,
    objective: meta.objective || "",
    stoppedAt: meta.stoppedAt || "",
    waitingFor: meta.waitingFor || null,
    nodes,
    node_summaries: nodeSummaries,
    outputs: meta.outputs || {},
    error: meta.error || "",
  };
}

function executePlanGraph(input = {}, options = {}) {
  const compiled = options.compiled && options.compiled.ok
    ? options.compiled
    : compilePlanGraph(input, options);
  if (!compiled.ok) {
    return {
      ok: false,
      error: compiled.errors.join("; ") || "plan compile failed",
      compile: compiled,
      summary: summarizeGraph(new Map(), {
        planId: compiled.planId,
        objective: compiled.objective,
        error: compiled.errors.join("; "),
      }),
      segmentId: compiled.planId,
      objective: compiled.objective,
      results: [],
      stoppedAt: "compile",
    };
  }

  const nodeMap = new Map();
  const seedMap = options.seedNodeMap instanceof Map
    ? options.seedNodeMap
    : (options.seedNodeMap && typeof options.seedNodeMap === "object"
      ? new Map(Object.entries(options.seedNodeMap))
      : null);

  for (const node of compiled.nodes) {
    const seed = seedMap ? seedMap.get(node.id) : null;
    let status = seed && seed.status ? String(seed.status) : "pending";
    // Re-enter the scheduler after a prior LLM/approval yield.
    // Keep running nodes so lease recovery can decide retry vs fail.
    if (
      status === "waiting_llm"
      || status === "waiting_approval"
      || status === "ready"
    ) {
      status = "pending";
    }
    nodeMap.set(node.id, {
      ...node,
      status,
      result: seed && seed.result ? seed.result : null,
      error: seed && seed.error ? seed.error : "",
      lease: seed && seed.lease ? seed.lease : null,
      attempt: seed && Number.isFinite(seed.attempt) ? seed.attempt : (node.attempt || 0),
      executionId: seed && seed.executionId ? seed.executionId : "",
    });
  }

  const outputs = new Map();
  if (options.seedOutputs instanceof Map) {
    for (const [id, value] of options.seedOutputs.entries()) outputs.set(id, value);
  } else if (options.seedOutputs && typeof options.seedOutputs === "object") {
    for (const [id, value] of Object.entries(options.seedOutputs)) outputs.set(id, value);
  }
  for (const node of nodeMap.values()) {
    if (node.status === "succeeded" && node.result && !outputs.has(node.id)) {
      outputs.set(node.id, node.result);
    }
  }

  const runTool = typeof options.runTool === "function"
    ? options.runTool
    : (typeof options.runStep === "function"
      ? ({ node, args }) => options.runStep({ stepId: node.id, tool: node.tool, args })
      : () => ({ ok: false, error: "no tool runner" }));
  const parallel = options.parallel === true;
  const failurePolicy = options.failurePolicy
    || compiled.failurePolicy
    || "continue_independent";
  const maxNodeRuns = Number.isFinite(options.maxNodeRuns)
    ? Math.max(1, Math.floor(options.maxNodeRuns))
    : 32;
  const workerId = String(options.workerId || "local");
  const leaseMs = Number.isFinite(options.leaseMs) ? options.leaseMs : undefined;

  let runs = 0;
  let stoppedAt = "";
  let waitingFor = null;

  while (!isTerminal(nodeMap) && runs < maxNodeRuns) {
    recoverExpiredLeases(nodeMap);

    const ready = getReadyNodes(nodeMap);
    if (ready.length === 0) {
      const running = Array.from(nodeMap.values()).filter((node) => node.status === "running");
      if (running.length > 0) {
        // Sync executor: running without in-loop wait means lease recovery needed next pass.
        break;
      }
      break;
    }

    const toolReady = ready.filter((node) => node.type === "tool");
    const aggregateReady = ready.filter((node) => isAggregateTask(node));
    const controlReady = ready.filter((node) => isLlmControlNode(node));

    if (aggregateReady.length > 0) {
      for (const node of aggregateReady) {
        const childIds = normalizeDependsOn(node.dependsOn);
        const childSummaries = childIds.map((id) => {
          const child = nodeMap.get(id);
          const summary = child && child.result && child.result.summary
            ? child.result.summary
            : (child ? child.status : "missing");
          return `${id}: ${summary}`;
        });
        const normalized = normalizeNodeResult({
          ok: true,
          output: {
            children: childIds,
            childOutputs: childIds.map((id) => {
              const child = nodeMap.get(id);
              return child && child.result ? child.result.output : null;
            }),
          },
          summary: childSummaries.join("; ") || `aggregate ${node.id} complete`,
        });
        node.status = "succeeded";
        node.result = normalized;
        node.lease = null;
        outputs.set(node.id, normalized);
        runs += 1;
      }
      continue;
    }

    if (toolReady.length > 0) {
      const batch = claimSafeReadyToolBatch(toolReady, {
        parallel,
        workerId,
        leaseMs,
        resolveArgs: (node) => resolveValue(node.args || {}, outputs),
      });
      if (batch.length === 0) {
        // All ready tools conflicted; fall through to controls or deadlock.
      } else {
        let failFastTriggered = false;
        for (const node of batch) {
          const args = resolveValue(node.args || {}, outputs);
          let raw;
          try {
            raw = runTool({
              node,
              args,
              tool: node.tool,
              stepId: node.id,
              lease: node.lease,
              executionId: node.executionId,
              attempt: node.attempt,
            });
            if (raw && typeof raw.then === "function") {
              throw new Error("async tool runners are not supported by executePlanGraph");
            }
          } catch (err) {
            raw = { ok: false, error: err && err.message ? err.message : "tool failed" };
          }
          const normalized = normalizeNodeResult(raw);
          if (!normalized.summary) {
            normalized.summary = `${node.tool} ${normalized.status === "succeeded" ? "ok" : "failed"}`;
          }
          runs += 1;
          node.lease = null;
          if (normalized.status === "succeeded") {
            node.status = "succeeded";
            node.result = normalized;
            outputs.set(node.id, normalized);
          } else {
            node.status = "failed";
            node.error = normalized.error || "tool failed";
            node.result = normalized;
            stoppedAt = "error";
            blockDependents(nodeMap, node.id);
            if (failurePolicy === "fail_fast") {
              for (const other of nodeMap.values()) {
                if (other.status === "pending" || other.status === "ready") {
                  other.status = "cancelled";
                  other.error = `fail_fast after ${node.id}`;
                }
              }
              failFastTriggered = true;
              waitingFor = {
                type: "failures",
                nodes: [{ id: node.id, error: node.error || "failed" }],
              };
              stoppedAt = "tool_failure_requires_decision";
              break;
            }
          }
        }
        if (failFastTriggered) break;
        continue;
      }
    }

    const control = controlReady[0];
    if (!control) {
      const failed = Array.from(nodeMap.values()).filter((node) => node.status === "failed");
      if (failed.length > 0) {
        stoppedAt = "tool_failure_requires_decision";
        waitingFor = {
          type: "failures",
          nodes: failed.map((node) => ({ id: node.id, error: node.error || "failed" })),
        };
      }
      break;
    }
    if (control.type === "task") {
      control.status = "waiting_llm";
      stoppedAt = "waiting_llm";
      waitingFor = {
        id: control.id,
        type: "task",
        objective: control.objective || control.title || "",
        title: control.title || control.objective || "",
        inputs: resolveValue(control.inputs || {}, outputs),
      };
      break;
    }
    if (control.type === "checkpoint") {
      control.status = control.mode === "approval" ? "waiting_approval" : "waiting_llm";
      stoppedAt = control.mode === "approval"
        ? "approval_required"
        : (control.stopKind === "side_effect" ? "side_effect" : "checkpoint");
      waitingFor = {
        id: control.id,
        type: "checkpoint",
        mode: control.mode,
        reason: control.reason || "",
        stopKind: control.stopKind || "checkpoint",
      };
      break;
    }
    control.status = "failed";
    control.error = `unsupported node type ${control.type}`;
    blockDependents(nodeMap, control.id);
  }

  const outputsObj = {};
  for (const [id, value] of outputs.entries()) outputsObj[id] = value.output;
  const summary = summarizeGraph(nodeMap, {
    planId: compiled.planId,
    objective: compiled.objective,
    stoppedAt,
    waitingFor,
    outputs: outputsObj,
  });
  let yieldReason = "";
  if (stoppedAt === "waiting_llm") yieldReason = "task_ready";
  else if (stoppedAt === "checkpoint") yieldReason = "llm_checkpoint_ready";
  else if (stoppedAt === "approval_required") yieldReason = "approval_required";
  else if (stoppedAt === "side_effect") yieldReason = "llm_checkpoint_ready";
  else if (stoppedAt === "tool_failure_requires_decision") yieldReason = "tool_failure_requires_decision";
  else if (stoppedAt === "error") yieldReason = "tool_failure_requires_decision";
  else if (isTerminal(nodeMap)) yieldReason = "graph_terminal";
  else yieldReason = "scheduler_deadlock";

  const ok = summary.status === "success"
    || summary.status === "checkpoint"
    || stoppedAt === "side_effect"
    || stoppedAt === "waiting_llm"
    || stoppedAt === "checkpoint"
    || stoppedAt === "approval_required";
  return {
    ok,
    yieldReason,
    error: ok ? "" : (stoppedAt === "error"
      ? (Array.from(nodeMap.values()).find((n) => n.status === "failed") || {}).error || "tool failed"
      : summary.status),
    compile: compiled,
    nodes: Array.from(nodeMap.values()),
    nodeMap,
    outputs,
    waitingFor,
    stoppedAt,
    summary,
    segmentId: compiled.planId,
    objective: compiled.objective,
    results: Array.from(nodeMap.values())
      .filter((node) => node.type === "tool" && node.result)
      .map((node) => ({
        stepId: node.id,
        tool: node.tool,
        ok: node.status === "succeeded",
        artifactId: node.result.artifactId || "",
        error: node.error || "",
      })),
  };
}

function applyPlanOperations(planInput = {}, operations = []) {
  const plan = normalizePlanGraph(planInput);
  const nodes = plan.nodes.slice();
  const ops = Array.isArray(operations) ? operations : [];
  const errors = [];
  let nextSeq = nodes.reduce((max, node) => Math.max(max, Number(node.createdSeq) || 0), 0) + 1;

  function findIndex(id) {
    return nodes.findIndex((node) => node.id === id);
  }

  function expandTask(op = {}) {
    const nodeId = String(op.nodeId || op.replaceNode || "").trim();
    const idx = findIndex(nodeId);
    if (idx < 0) {
      errors.push(`expand_node target missing: ${nodeId}`);
      return;
    }
    const target = nodes[idx];
    if (target.type !== "task") {
      errors.push(`expand_node requires task node: ${nodeId}`);
      return;
    }
    if (getTaskExecutionKind(target) === "aggregate") {
      errors.push(`task already expanded: ${nodeId}`);
      return;
    }
    if (target.status && !["pending", "waiting_llm", "ready"].includes(String(target.status))) {
      errors.push(`task not expandable in status ${target.status}: ${nodeId}`);
      return;
    }

    let children = [];
    let strategy = "parallel";
    if (Array.isArray(op.children)) {
      children = op.children;
      strategy = String(op.strategy || "parallel").trim().toLowerCase() === "sequence"
        ? "sequence"
        : "parallel";
    } else {
      const replacement = op.with || op.subgraph || op.node;
      if (replacement && replacement.type === "group") {
        children = Array.isArray(replacement.children) ? replacement.children : [];
        strategy = String(replacement.strategy || "parallel").trim().toLowerCase() === "sequence"
          ? "sequence"
          : "parallel";
      } else if (replacement) {
        children = [replacement];
      }
    }
    if (children.length === 0) {
      errors.push(`expand_node requires children: ${nodeId}`);
      return;
    }

    const parentDeps = normalizeDependsOn(target.dependsOn);
    const childIds = [];
    let seqPrev = null;
    children.forEach((child, index) => {
      const deps = normalizeDependsOn(child && child.dependsOn).concat(parentDeps);
      if (strategy === "sequence" && seqPrev) deps.push(seqPrev);
      const normalized = normalizePlanNode({
        ...child,
        dependsOn: Array.from(new Set(deps)),
        parentTaskId: nodeId,
        generated: true,
        displayOrder: index,
        createdSeq: nextSeq,
        status: "pending",
        attempt: 0,
      }, `${nodeId}_c${index + 1}`);
      nextSeq += 1;
      if (findIndex(normalized.id) >= 0) {
        errors.push(`duplicate node id while expanding: ${normalized.id}`);
        return;
      }
      nodes.push(normalized);
      childIds.push(normalized.id);
      seqPrev = normalized.id;
    });
    if (errors.length > 0) return;

    const sinks = strategy === "sequence"
      ? (childIds.length ? [childIds[childIds.length - 1]] : [])
      : childIds.slice();

    nodes[idx] = {
      ...target,
      type: "task",
      execution: { kind: "aggregate" },
      dependsOn: sinks,
      status: "pending",
      result: null,
      error: "",
    };
  }

  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const type = String(op.op || op.type || "").trim().toLowerCase();
    if (type === "add_node" && op.node) {
      const node = normalizePlanNode({
        ...op.node,
        status: "pending",
        createdSeq: nextSeq,
        attempt: 0,
      }, `n${nodes.length + 1}`);
      nextSeq += 1;
      if (findIndex(node.id) >= 0) {
        errors.push(`duplicate node id: ${node.id}`);
        continue;
      }
      // Models cannot create aggregate tasks directly.
      if (node.type === "task" && getTaskExecutionKind(node) === "aggregate") {
        node.execution = { kind: "inline_llm" };
      }
      nodes.push(node);
      continue;
    }
    if (type === "expand" || type === "expand_node") {
      expandTask(op);
      continue;
    }
    if (type === "replace_node") {
      errors.push("replace_node is disabled in v1; use expand_node or add_node");
      continue;
    }
    if (type === "add_dependency") {
      const nodeId = String(op.nodeId || "").trim();
      const dep = String(op.dependsOn || op.dep || "").trim();
      const idx = findIndex(nodeId);
      if (idx < 0 || !dep) continue;
      const node = nodes[idx];
      if (node.status && !["pending", "waiting_llm", "ready"].includes(String(node.status))) {
        errors.push(`cannot modify dependencies of ${nodeId} in status ${node.status}`);
        continue;
      }
      nodes[idx] = {
        ...node,
        dependsOn: Array.from(new Set(normalizeDependsOn(node.dependsOn).concat([dep]))),
      };
      continue;
    }
    if (type === "remove_dependency") {
      const nodeId = String(op.nodeId || "").trim();
      const dep = String(op.dependsOn || op.dep || "").trim();
      const idx = findIndex(nodeId);
      if (idx < 0 || !dep) continue;
      const node = nodes[idx];
      if (node.status && !["pending", "waiting_llm", "ready"].includes(String(node.status))) {
        errors.push(`cannot modify dependencies of ${nodeId} in status ${node.status}`);
        continue;
      }
      nodes[idx] = {
        ...node,
        dependsOn: normalizeDependsOn(node.dependsOn).filter((item) => item !== dep),
      };
      continue;
    }
    if (type === "complete_task" || type === "skip_node" || type === "cancel_subtree") {
      errors.push(
        `${type} is a control action; use plan_graph operation=control (not patch)`,
      );
      continue;
    }
    if (type === "set_status") {
      errors.push("set_status is removed; use control complete_task / skip_node / cancel_subtree");
      continue;
    }
  }

  return {
    id: plan.id,
    objective: plan.objective,
    nodes,
    errors,
  };
}

/**
 * Runtime status mutations for control-plane actions (not patch/spec edits).
 * Mutates planGraph.nodes in place. Used by plan_graph operation=control.
 */
function applyControlNodeAction(planGraph = null, action = {}) {
  if (!planGraph || !Array.isArray(planGraph.nodes)) {
    return {
      ok: false,
      errors: [{ code: "GRAPH_MISSING", message: "plan graph missing" }],
    };
  }
  const op = String(action.op || action.type || "").trim().toLowerCase();
  const nodes = planGraph.nodes;
  const findIndex = (id) => nodes.findIndex((node) => node && node.id === id);
  const errors = [];

  if (op === "complete_task") {
    const nodeId = String(action.nodeId || "").trim();
    const idx = findIndex(nodeId);
    if (idx < 0) {
      return {
        ok: false,
        errors: [{ code: "NODE_NOT_FOUND", message: `complete_task target missing: ${nodeId}` }],
      };
    }
    const node = nodes[idx];
    if (node.type !== "task" || isAggregateTask(node)) {
      return {
        ok: false,
        errors: [{ code: "NOT_INLINE_TASK", message: `complete_task requires llm task: ${nodeId}` }],
      };
    }
    if (getTaskExecutionKind(node) === "task_loop") {
      return {
        ok: false,
        errors: [{
          code: "USE_TASK_RUN_ID",
          message: `task_loop ${nodeId} must complete via control.complete_task with taskRunId`,
        }],
      };
    }
    if (node.status !== "waiting_llm") {
      return {
        ok: false,
        errors: [{
          code: "BAD_STATUS",
          message: `complete_task requires waiting_llm: ${nodeId} (got ${node.status})`,
        }],
      };
    }
    const result = normalizeNodeResult(action.result || {
      ok: true,
      output: action.output || {},
      summary: action.summary || `completed ${nodeId}`,
    });
    nodes[idx] = {
      ...node,
      status: "succeeded",
      result,
      error: "",
    };
  } else if (op === "skip_node") {
    const nodeId = String(action.nodeId || "").trim();
    const idx = findIndex(nodeId);
    if (idx < 0) {
      return {
        ok: false,
        errors: [{ code: "NODE_NOT_FOUND", message: `skip_node target missing: ${nodeId}` }],
      };
    }
    const node = nodes[idx];
    if (node.status && !["pending", "waiting_llm", "ready"].includes(String(node.status))) {
      return {
        ok: false,
        errors: [{
          code: "BAD_STATUS",
          message: `cannot skip ${nodeId} in status ${node.status}`,
        }],
      };
    }
    nodes[idx] = { ...node, status: "skipped", error: String(action.reason || "skipped") };
  } else if (op === "cancel_subtree") {
    const nodeId = String(action.nodeId || "").trim();
    const idx = findIndex(nodeId);
    if (idx < 0) {
      return {
        ok: false,
        errors: [{ code: "NODE_NOT_FOUND", message: `cancel_subtree target missing: ${nodeId}` }],
      };
    }
    const cancelled = new Set([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (!node || cancelled.has(node.id)) continue;
        const deps = normalizeDependsOn(node.dependsOn);
        if (deps.some((dep) => cancelled.has(dep)) || node.parentTaskId === nodeId) {
          cancelled.add(node.id);
          changed = true;
        }
      }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      if (!cancelled.has(nodes[i].id)) continue;
      if (["succeeded", "failed"].includes(String(nodes[i].status || ""))) continue;
      nodes[i] = {
        ...nodes[i],
        status: "cancelled",
        error: String(action.reason || `cancelled via ${nodeId}`),
      };
    }
  } else {
    return {
      ok: false,
      errors: [{ code: "UNKNOWN_CONTROL_OP", message: `unknown control op: ${op}` }],
    };
  }

  planGraph.stateRevision = (Number(planGraph.stateRevision) || 0) + 1;
  const waiting = planGraph.waitingFor;
  const touchId = String(action.nodeId || "").trim();
  if (waiting && touchId && String(waiting.id || "") === touchId) {
    planGraph.waitingFor = null;
    planGraph.lastStoppedAt = "";
    planGraph.lastYieldReason = "";
  }

  return {
    ok: errors.length === 0,
    errors: errors.length ? errors : undefined,
    nodeId: touchId,
    op,
  };
}

module.exports = {
  NODE_TYPES,
  NODE_STATUSES,
  TOOL_ALIASES,
  SIDE_EFFECT_TOOLS,
  createPlanId,
  normalizePlanNode,
  normalizePlanGraph,
  planGraphFromExecutionSegment,
  compilePlanGraph,
  resolveValue,
  resolveRefToken,
  resolveStructuredRef,
  executePlanGraph,
  applyPlanOperations,
  applyControlNodeAction,
  flattenPlanNodes,
  rewriteGroupDependencies,
  detectCycles,
  getReadyNodes,
  compareNodeOrder,
  isAggregateTask,
  isLlmControlNode,
  isTaskLoopNode,
  getTaskExecutionKind,
  isTerminal,
  summarizeGraph,
  resolveToolName,
  collectRefsFromValue,
};
