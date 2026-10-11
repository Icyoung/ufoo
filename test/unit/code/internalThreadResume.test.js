"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { persistSessionState } = require("../../../src/code/agent");
const { appendTurnMessages } = require("../../../src/code/conversation/sessionJournal");
const { createInternalCodingThread } = require("../../../src/code/internalThread");

test("internal ucode resumes the native journal, provider, model and context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-native-resume-"));
  try {
    const messages = [{ role: "user", content: "Keep the existing design" }, { role: "assistant", content: "I recorded that constraint" }];
    appendTurnMessages(root, "ucode-existing", "seed", messages, { scope: "seed" });
    expect(persistSessionState({ workspaceRoot: root, sessionId: "ucode-existing", provider: "openai",
      model: "saved-model", context: "saved rules", nlMessages: messages }).ok).toBe(true);
    const runTask = jest.fn(async (_input, state) => {
      expect(state.nlMessages).toEqual(messages);
      expect(state.provider).toBe("openai");
      expect(state.model).toBe("saved-model");
      expect(state.context).toContain("saved rules");
      return { ok: true, summary: "continued" };
    });
    const thread = createInternalCodingThread({ workspaceRoot: root, sessionId: "ucode-existing", runTask });
    const events = [];
    for await (const event of thread.runStreamed("Continue")) events.push(event);
    expect(thread.id).toBe("ucode-existing");
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "text_delta", delta: "continued" });
    await thread.close();
    expect(() => createInternalCodingThread({ workspaceRoot: root, sessionId: "missing-session", runTask })).toThrow(/session|ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
