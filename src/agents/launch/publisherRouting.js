const fs = require("fs");
const { getUfooPaths } = require("../../coordination/state/paths");

function normalizePublisher(publisher) {
  if (typeof publisher === "string") return publisher.trim();
  if (publisher && typeof publisher === "object") {
    return String(publisher.subscriber || publisher.id || publisher.nickname || "").trim();
  }
  return String(publisher || "").trim();
}

function readAgents(projectRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));
    return parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object"
      ? parsed.agents
      : {};
  } catch {
    return {};
  }
}

function isManagedAgentPublisher(projectRoot, publisher) {
  const id = normalizePublisher(publisher);
  if (!id) return false;
  const agents = readAgents(projectRoot);
  return Boolean(agents[id]);
}

function shouldForwardStreamToPublisher(projectRoot, publisher) {
  const id = normalizePublisher(publisher);
  if (!id) return false;
  return !isManagedAgentPublisher(projectRoot, id);
}

function shouldAutoReplyFromPtyToPublisher(projectRoot, publisher) {
  return shouldForwardStreamToPublisher(projectRoot, publisher);
}

function parseStreamEnvelope(message) {
  if (typeof message !== "string" || !message.trim()) return null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && parsed.stream === true) {
      return parsed;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

module.exports = {
  isManagedAgentPublisher,
  normalizePublisher,
  parseStreamEnvelope,
  shouldAutoReplyFromPtyToPublisher,
  shouldForwardStreamToPublisher,
};
