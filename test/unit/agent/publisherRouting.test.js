const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isManagedAgentPublisher,
  parseStreamEnvelope,
  shouldAutoReplyFromPtyToPublisher,
  shouldForwardStreamToPublisher,
} = require("../../../src/agents/launch/publisherRouting");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-publisher-routing-"));
  const paths = getUfooPaths(projectRoot);
  fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
  fs.writeFileSync(paths.agentsFile, JSON.stringify({
    agents: {
      "codex:abc": {
        agent_type: "codex",
        nickname: "builder",
        status: "active",
      },
    },
  }));
  return projectRoot;
}

describe("agent publisher routing", () => {
  test("detects managed agent publishers from the project registry", () => {
    const projectRoot = makeProject();

    expect(isManagedAgentPublisher(projectRoot, "codex:abc")).toBe(true);
    expect(isManagedAgentPublisher(projectRoot, "claude-code:chat-session")).toBe(false);
    expect(shouldForwardStreamToPublisher(projectRoot, "codex:abc")).toBe(false);
    expect(shouldForwardStreamToPublisher(projectRoot, "claude-code:chat-session")).toBe(true);
    expect(shouldAutoReplyFromPtyToPublisher(projectRoot, "codex:abc")).toBe(false);
    expect(shouldAutoReplyFromPtyToPublisher(projectRoot, "claude-code:chat-session")).toBe(true);
  });

  test("recognizes stream envelopes", () => {
    expect(parseStreamEnvelope(JSON.stringify({ stream: true, delta: "x" }))).toMatchObject({
      stream: true,
      delta: "x",
    });
    expect(parseStreamEnvelope(JSON.stringify({ text: "task" }))).toBeNull();
    expect(parseStreamEnvelope("plain task")).toBeNull();
  });
});
