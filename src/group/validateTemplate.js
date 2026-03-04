"use strict";

const ALLOWED_AGENT_TYPES = new Set(["codex", "claude", "ucode"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function addError(errors, path, message) {
  errors.push({ path, message });
}

function validateReferenceArray({
  errors,
  fieldName,
  fieldValue,
  pathPrefix,
  knownNicknames,
  currentNickname,
}) {
  if (fieldValue === undefined) return;
  if (!Array.isArray(fieldValue)) {
    addError(errors, pathPrefix, `${fieldName} must be an array`);
    return;
  }
  for (let i = 0; i < fieldValue.length; i += 1) {
    const value = asTrimmedString(fieldValue[i]);
    const valuePath = `${pathPrefix}[${i}]`;
    if (!value) {
      addError(errors, valuePath, `${fieldName} entry must be a non-empty string`);
      continue;
    }
    if (fieldName === "depends_on" && currentNickname && value === currentNickname) {
      addError(errors, valuePath, "depends_on cannot reference itself");
      continue;
    }
    if (!knownNicknames.has(value)) {
      addError(errors, valuePath, `${fieldName} reference "${value}" does not exist`);
    }
  }
}

function detectDependsCycle(agents = []) {
  const deps = new Map();
  const nicknameOrder = [];

  for (const agent of agents) {
    const nickname = asTrimmedString(agent && agent.nickname);
    if (!nickname) continue;
    nicknameOrder.push(nickname);
    const dependsOn = Array.isArray(agent.depends_on)
      ? agent.depends_on.map((item) => asTrimmedString(item)).filter(Boolean)
      : [];
    deps.set(nickname, dependsOn);
  }

  const state = new Map();
  const stack = [];

  function dfs(node) {
    const seen = state.get(node) || 0;
    if (seen === 1) {
      const idx = stack.indexOf(node);
      const cycle = idx >= 0 ? stack.slice(idx).concat(node) : [node, node];
      return cycle;
    }
    if (seen === 2) return null;

    state.set(node, 1);
    stack.push(node);

    const neighbors = deps.get(node) || [];
    for (const neighbor of neighbors) {
      if (!deps.has(neighbor)) continue;
      const cycle = dfs(neighbor);
      if (cycle) return cycle;
    }

    stack.pop();
    state.set(node, 2);
    return null;
  }

  for (const nickname of nicknameOrder) {
    const cycle = dfs(nickname);
    if (cycle) return cycle;
  }
  return null;
}

function validateTemplate(doc) {
  const errors = [];

  if (!isPlainObject(doc)) {
    addError(errors, "$", "template document must be a JSON object");
    return { ok: false, errors };
  }

  if (!Number.isInteger(doc.schema_version) || doc.schema_version < 1) {
    addError(errors, "schema_version", "schema_version must be an integer >= 1");
  }

  if (!isPlainObject(doc.template)) {
    addError(errors, "template", "template must be an object");
  } else {
    if (!asTrimmedString(doc.template.id)) {
      addError(errors, "template.id", "template.id is required");
    }
    if (!asTrimmedString(doc.template.alias)) {
      addError(errors, "template.alias", "template.alias is required");
    }
    if (!asTrimmedString(doc.template.name)) {
      addError(errors, "template.name", "template.name is required");
    }
  }

  if (!Array.isArray(doc.agents) || doc.agents.length === 0) {
    addError(errors, "agents", "agents must be a non-empty array");
    return { ok: false, errors };
  }

  const knownNicknames = new Set();

  for (let i = 0; i < doc.agents.length; i += 1) {
    const agent = doc.agents[i];
    const basePath = `agents[${i}]`;

    if (!isPlainObject(agent)) {
      addError(errors, basePath, "agent must be an object");
      continue;
    }

    const nickname = asTrimmedString(agent.nickname);
    if (!nickname) {
      addError(errors, `${basePath}.nickname`, "nickname is required");
    } else if (knownNicknames.has(nickname)) {
      addError(errors, `${basePath}.nickname`, `duplicate nickname "${nickname}"`);
    } else {
      knownNicknames.add(nickname);
    }

    const agentType = asTrimmedString(agent.type);
    if (!ALLOWED_AGENT_TYPES.has(agentType)) {
      addError(
        errors,
        `${basePath}.type`,
        `type must be one of: ${Array.from(ALLOWED_AGENT_TYPES).join(", ")}`
      );
    }

    if (!Number.isInteger(agent.startup_order) || agent.startup_order < 0) {
      addError(errors, `${basePath}.startup_order`, "startup_order must be an integer >= 0");
    }
  }

  for (let i = 0; i < doc.agents.length; i += 1) {
    const agent = doc.agents[i];
    const basePath = `agents[${i}]`;
    if (!isPlainObject(agent)) continue;

    const nickname = asTrimmedString(agent.nickname);
    validateReferenceArray({
      errors,
      fieldName: "depends_on",
      fieldValue: agent.depends_on,
      pathPrefix: `${basePath}.depends_on`,
      knownNicknames,
      currentNickname: nickname,
    });
    validateReferenceArray({
      errors,
      fieldName: "accept_from",
      fieldValue: agent.accept_from,
      pathPrefix: `${basePath}.accept_from`,
      knownNicknames,
      currentNickname: nickname,
    });
    validateReferenceArray({
      errors,
      fieldName: "report_to",
      fieldValue: agent.report_to,
      pathPrefix: `${basePath}.report_to`,
      knownNicknames,
      currentNickname: nickname,
    });
  }

  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    addError(errors, "edges", "edges must be an array when provided");
  } else if (Array.isArray(doc.edges)) {
    for (let i = 0; i < doc.edges.length; i += 1) {
      const edge = doc.edges[i];
      const basePath = `edges[${i}]`;
      if (!isPlainObject(edge)) {
        addError(errors, basePath, "edge must be an object");
        continue;
      }

      const from = asTrimmedString(edge.from);
      const to = asTrimmedString(edge.to);
      if (!from) {
        addError(errors, `${basePath}.from`, "from is required");
      } else if (!knownNicknames.has(from)) {
        addError(errors, `${basePath}.from`, `edge source "${from}" does not exist`);
      }
      if (!to) {
        addError(errors, `${basePath}.to`, "to is required");
      } else if (!knownNicknames.has(to)) {
        addError(errors, `${basePath}.to`, `edge target "${to}" does not exist`);
      }
    }
  }

  const cycle = detectDependsCycle(doc.agents);
  if (cycle) {
    addError(
      errors,
      "agents[*].depends_on",
      `cyclic depends_on detected: ${cycle.join(" -> ")}`
    );
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  ALLOWED_AGENT_TYPES,
  validateTemplate,
};
