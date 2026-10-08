"use strict";

const { createToolRegistry } = require("./tools/registry");

/** Explicit, trusted modules only. This composition is not a code sandbox. */
function composeCapabilities({ capabilities = [], host = {}, profile = {}, providerFeatures = [] } = {}) {
  const byId = new Map();
  for (const capability of capabilities) {
    if (!capability || !/^[a-z][a-z0-9-]{0,63}$/.test(capability.id || "") || !capability.version) throw new Error("capability id/version required");
    if (byId.has(capability.id)) throw new Error(`duplicate capability: ${capability.id}`);
    byId.set(capability.id, capability);
  }
  const selected = profile.capabilities || [...byId.keys()];
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`circular capability dependency: ${id}`);
    if (visited.has(id)) return;
    const capability = byId.get(id);
    if (!capability) throw new Error(`missing capability: ${id}`);
    visiting.add(id);
    for (const dependency of capability.requires && capability.requires.capabilities || []) visit(dependency);
    for (const port of capability.requires && capability.requires.ports || []) {
      if (host[port] == null) throw new Error(`capability ${id} requires host port: ${port}`);
    }
    for (const permission of capability.requestedPermissions || []) {
      if (!(host.grantedPermissions || []).includes(permission)) {
        throw new Error(`capability ${id} requires permission: ${permission}`);
      }
    }
    for (const feature of capability.requires && capability.requires.providerFeatures || []) {
      if (!providerFeatures.includes(feature)) throw new Error(`capability ${id} requires provider feature: ${feature}`);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(capability);
  }
  selected.forEach(visit);
  const tools = createToolRegistry({
    tools: ordered.flatMap((capability) => capability.tools || []),
    grantedPermissions: host.grantedPermissions || [],
    authorize: host.authorizeTool || null,
  });
  const policies = ordered.map((capability) => capability.policy).filter(Boolean);
  return Object.freeze({
    capabilities: Object.freeze(ordered.slice()),
    tools,
    policies: Object.freeze(policies),
    reduceState(records = {}, event) {
      const updates = [];
      for (const capability of ordered) {
        if (!capability.reducer) continue;
        const previous = Object.prototype.hasOwnProperty.call(records, capability.id) ? records[capability.id] : null;
        const codec = capability.stateCodec;
        if (previous && String(previous.version) !== String(capability.version) && (!codec || !codec.decode)) {
          throw new Error(`unsupported capability state version: ${capability.id}`);
        }
        const value = previous ? codec && codec.decode ? codec.decode(previous.value, previous.version) : previous.value : undefined;
        const next = capability.reducer(value, event);
        if (next && typeof next.then === "function") throw new Error(`capability reducer must be synchronous: ${capability.id}`);
        if (next !== undefined) updates.push({ capabilityId: capability.id, version: capability.version, value: codec && codec.encode ? codec.encode(next) : next });
      }
      return updates;
    },
    async handleEvent(event) {
      const commands = [];
      for (const capability of ordered) {
        if (!capability.handleEvent) continue;
        const proposals = await capability.handleEvent(event);
        if (proposals != null && !Array.isArray(proposals)) throw new Error(`capability event handler must return commands: ${capability.id}`);
        for (const command of proposals || []) commands.push({ ...command, capabilityId: capability.id });
      }
      return commands;
    },
    promptSections: Object.freeze(ordered.flatMap((capability) => capability.promptSections || [])),
    async buildContext(input) {
      const result = [];
      for (const capability of ordered) {
        for (const source of capability.contextSources || []) {
          result.push({ capabilityId: capability.id, value: await source(input, host) });
        }
      }
      return result;
    },
  });
}

module.exports = { composeCapabilities };
