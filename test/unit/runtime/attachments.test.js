"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  stageAttachments,
  loadAttachmentModelContext,
  buildUserMessageContent,
  formatAttachmentPromptSummary,
} = require("../../../src/runtime/attachments");
const { buildCodexInput } = require("../../../src/agents/providers/codexThreadProvider");
const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports/openaiChatTransport");
const { createAnthropicMessagesTransport } = require("../../../src/agents/providers/transports/anthropicMessagesTransport");
const { createOpenAiResponsesTransport } = require("../../../src/agents/providers/transports/openaiResponsesTransport");

// Valid minimal 1x1 PNG binary
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe("Attachment staging, multimodal vision blocks, and worker inputs", () => {
  test("stages workspace files in place, copies external files into .ufoo/attachments, and decodes base64 uploads", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-att-proj-"));
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-att-ext-"));
    try {
      const localSpec = path.join(projectRoot, "spec.md");
      fs.writeFileSync(localSpec, "# Spec\nhello", "utf8");

      const externalImg = path.join(externalDir, "screen shot.png");
      fs.writeFileSync(externalImg, TINY_PNG);

      const res = stageAttachments(projectRoot, {
        paths: [localSpec, externalImg, externalDir],
        uploads: [
          {
            name: "pasted.png",
            data_base64: `data:image/png;base64,${TINY_PNG.toString("base64")}`,
            media_type: "image/png",
          },
        ],
      });

      expect(res.ok).toBe(true);
      expect(res.errors).toHaveLength(1); // directory rejected
      expect(res.attachments).toHaveLength(3);

      const [specAtt, extImgAtt, pasteAtt] = res.attachments;
      expect(specAtt.kind).toBe("file");
      expect(specAtt.path).toBe(fs.realpathSync(localSpec).replace(/^\/private/, "") === localSpec ? localSpec : path.resolve(localSpec));
      expect(specAtt.preview_data_url).toBeUndefined();

      // External image copied into .ufoo/attachments
      expect(extImgAtt.kind).toBe("image");
      expect(extImgAtt.media_type).toBe("image/png");
      expect(extImgAtt.path).toContain(path.join(".ufoo", "attachments"));
      expect(fs.existsSync(extImgAtt.path)).toBe(true);
      expect(extImgAtt.preview_data_url).toMatch(/^data:image\/png;base64,/);

      // Base64 paste written into .ufoo/attachments
      expect(pasteAtt.kind).toBe("image");
      expect(pasteAtt.path).toContain(path.join(".ufoo", "attachments"));
      expect(fs.existsSync(pasteAtt.path)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("builds multimodal vision payloads, Codex local_image inputs, and transport user messages", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-att-vis-"));
    try {
      const imgPath = path.join(projectRoot, "mock.png");
      const docPath = path.join(projectRoot, "notes.txt");
      fs.writeFileSync(imgPath, TINY_PNG);
      fs.writeFileSync(docPath, "hello notes", "utf8");

      const ctx = loadAttachmentModelContext([imgPath, docPath], projectRoot);
      expect(ctx.visionPayloads).toHaveLength(1);
      expect(ctx.imagePaths).toEqual([imgPath]);
      expect(ctx.filePaths).toEqual([docPath]);
      expect(ctx.promptAppendix).toContain("Attached images:");
      expect(ctx.promptAppendix).toContain("Attached files");

      // Summary fallback when user sends only attachments with empty text
      expect(formatAttachmentPromptSummary("", ctx.attachments)).toContain("mock.png");

      // Strict Anthropic image block (no extraneous keys)
      const anthropicContent = buildUserMessageContent("Inspect this", ctx.visionPayloads, "anthropic");
      expect(anthropicContent).toEqual([
        { type: "text", text: "Inspect this" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: TINY_PNG.toString("base64"),
          },
        },
      ]);

      // Codex SDK native local_image input
      const codexInput = buildCodexInput("Fix UI", { attachments: ctx.attachments, cwd: projectRoot });
      expect(codexInput).toEqual([
        { type: "text", text: "Fix UI" },
        { type: "local_image", path: imgPath },
      ]);
      expect(buildCodexInput("Text only", { attachments: [docPath], cwd: projectRoot })).toBe("Text only");

      // Verify transports normalize userContent properly
      const noopDeps = {
        resolveUrl: () => "https://example.test",
        runTurn: async () => ({}),
        normalizeToolName: (n) => n,
        normalizeToolCallArgs: (a) => a,
        toJsonString: (v) => JSON.stringify(v),
        clipText: (t) => t,
      };
      const chatMsgs = [];
      createOpenAiChatTransport(noopDeps).prepareMessages({
        messages: chatMsgs,
        systemPrompt: "sys",
        prompt: "Inspect this",
        userContent: anthropicContent,
      });
      expect(chatMsgs[1].role).toBe("user");
      expect(chatMsgs[1].content[1]).toEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${TINY_PNG.toString("base64")}` },
      });

      const anthMsgs = [];
      createAnthropicMessagesTransport(noopDeps).prepareMessages({
        messages: anthMsgs,
        prompt: "Inspect this",
        userContent: anthropicContent,
      });
      expect(anthMsgs[0]).toEqual({ role: "user", content: anthropicContent });

      const respMsgs = [];
      createOpenAiResponsesTransport(noopDeps).prepareMessages({
        messages: respMsgs,
        prompt: "Inspect this",
        userContent: anthropicContent,
      });
      expect(respMsgs[0]).toEqual({ role: "user", content: anthropicContent });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
