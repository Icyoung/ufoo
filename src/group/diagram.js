"use strict";

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeFormat(format = "") {
  const value = asTrimmedString(format).toLowerCase();
  return value === "mermaid" ? "mermaid" : "ascii";
}

function toMemberNickname(member = {}, fallback = "") {
  return asTrimmedString(member.nickname) || asTrimmedString(member.id) || fallback;
}

function collectTemplateMembers(templateDoc = {}) {
  const agents = Array.isArray(templateDoc.agents) ? templateDoc.agents : [];
  return agents
    .map((agent, index) => ({
      nickname: toMemberNickname(agent, `agent_${index + 1}`),
      id: asTrimmedString(agent.id),
      type: asTrimmedString(agent.type),
      startup_order: Number.isInteger(agent.startup_order) ? agent.startup_order : null,
      depends_on: Array.isArray(agent.depends_on)
        ? agent.depends_on.map((dep) => asTrimmedString(dep)).filter(Boolean)
        : [],
      status: asTrimmedString(agent.status),
      subscriber_id: asTrimmedString(agent.subscriber_id),
    }))
    .filter((item) => item.nickname);
}

function collectRuntimeMembers(runtime = {}) {
  const members = Array.isArray(runtime.members) ? runtime.members : [];
  return members
    .map((member, index) => ({
      nickname: toMemberNickname(member, `agent_${index + 1}`),
      id: asTrimmedString(member.template_agent_id) || asTrimmedString(member.id),
      type: asTrimmedString(member.type),
      startup_order: Number.isInteger(member.startup_order) ? member.startup_order : null,
      depends_on: Array.isArray(member.depends_on)
        ? member.depends_on.map((dep) => asTrimmedString(dep)).filter(Boolean)
        : [],
      status: asTrimmedString(member.status),
      subscriber_id: asTrimmedString(member.subscriber_id),
    }))
    .filter((item) => item.nickname);
}

function collectTemplateEdges(templateDoc = {}, members = []) {
  const known = new Set(members.map((member) => member.nickname));
  const edges = [];
  const seen = new Set();

  function addEdge(from, to, kind) {
    const source = asTrimmedString(from);
    const target = asTrimmedString(to);
    if (!source || !target) return;
    if (!known.has(source) || !known.has(target)) return;
    const edgeKind = asTrimmedString(kind);
    const key = `${source}->${target}:${edgeKind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: source, to: target, kind: edgeKind });
  }

  const rawEdges = Array.isArray(templateDoc.edges) ? templateDoc.edges : [];
  rawEdges.forEach((edge) => {
    if (!edge || typeof edge !== "object") return;
    addEdge(edge.from, edge.to, edge.kind);
  });

  members.forEach((member) => {
    member.depends_on.forEach((dep) => addEdge(dep, member.nickname, "depends_on"));
  });

  return edges;
}

function collectRuntimeEdges(members = []) {
  const known = new Set(members.map((member) => member.nickname));
  const edges = [];
  const seen = new Set();
  members.forEach((member) => {
    member.depends_on.forEach((dep) => {
      if (!known.has(dep)) return;
      const key = `${dep}->${member.nickname}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from: dep, to: member.nickname, kind: "depends_on" });
    });
  });
  return edges;
}

function formatMemberLine(member = {}) {
  const type = member.type || "unknown";
  const order = Number.isInteger(member.startup_order) ? member.startup_order : "-";
  const deps = Array.isArray(member.depends_on) && member.depends_on.length > 0
    ? member.depends_on.join(", ")
    : "-";
  const status = member.status ? ` status=${member.status}` : "";
  const subscriber = member.subscriber_id ? ` sub=${member.subscriber_id}` : "";
  return `- ${member.nickname} [${type}] order=${order} deps=${deps}${status}${subscriber}`;
}

function renderAsciiDiagram(metadata = {}, members = [], edges = []) {
  const mode = metadata.mode || "template";
  const name = metadata.name || "unknown";
  const lines = [`Group Diagram (${mode}: ${name})`];
  if (metadata.status) {
    lines.push(`Status: ${metadata.status}`);
  }
  lines.push(`Members (${members.length}):`);
  members.forEach((member) => {
    lines.push(formatMemberLine(member));
  });
  if (edges.length === 0) {
    lines.push("Edges: none");
  } else {
    lines.push(`Edges (${edges.length}):`);
    edges.forEach((edge) => {
      const suffix = edge.kind ? ` (${edge.kind})` : "";
      lines.push(`- ${edge.from} -> ${edge.to}${suffix}`);
    });
  }
  return lines.join("\n");
}

function normalizeMermaidId(value = "", fallback = "node") {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^[^A-Za-z_]+/, "");
  return normalized || fallback;
}

function escapeMermaidLabel(value = "") {
  return String(value || "")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n");
}

function renderMermaidDiagram(members = [], edges = []) {
  const lines = ["flowchart LR"];
  const nodeIdMap = new Map();
  const taken = new Set();

  members.forEach((member, index) => {
    const base = normalizeMermaidId(member.nickname, `node_${index + 1}`);
    let id = base;
    let suffix = 1;
    while (taken.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    taken.add(id);
    nodeIdMap.set(member.nickname, id);
    const labelParts = [member.nickname];
    if (member.type) labelParts.push(member.type);
    if (member.status) labelParts.push(member.status);
    lines.push(`  ${id}["${escapeMermaidLabel(labelParts.join("\n"))}"]`);
  });

  edges.forEach((edge) => {
    const fromId = nodeIdMap.get(edge.from);
    const toId = nodeIdMap.get(edge.to);
    if (!fromId || !toId) return;
    const edgeLabel = edge.kind ? `|${escapeMermaidLabel(edge.kind)}|` : "";
    lines.push(`  ${fromId} -->${edgeLabel} ${toId}`);
  });

  return lines.join("\n");
}

function resolveTemplateName(templateDoc = {}, fallback = "") {
  const templateMeta = templateDoc && templateDoc.template && typeof templateDoc.template === "object"
    ? templateDoc.template
    : {};
  return asTrimmedString(templateMeta.alias) || asTrimmedString(templateMeta.id) || asTrimmedString(templateMeta.name) || fallback;
}

function renderGroupDiagramFromTemplate(templateDoc = {}, options = {}) {
  const format = normalizeFormat(options.format);
  const members = collectTemplateMembers(templateDoc);
  const edges = collectTemplateEdges(templateDoc, members);
  if (format === "mermaid") {
    return renderMermaidDiagram(members, edges);
  }
  return renderAsciiDiagram(
    {
      mode: "template",
      name: resolveTemplateName(templateDoc, "template"),
    },
    members,
    edges
  );
}

function renderGroupDiagramFromRuntime(runtime = {}, options = {}) {
  const format = normalizeFormat(options.format);
  const members = collectRuntimeMembers(runtime);
  const edges = collectRuntimeEdges(members);
  if (format === "mermaid") {
    return renderMermaidDiagram(members, edges);
  }
  return renderAsciiDiagram(
    {
      mode: "runtime",
      name: asTrimmedString(runtime.group_id) || "runtime",
      status: asTrimmedString(runtime.status),
    },
    members,
    edges
  );
}

module.exports = {
  normalizeFormat,
  renderGroupDiagramFromTemplate,
  renderGroupDiagramFromRuntime,
};
