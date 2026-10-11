import { describe, expect, it } from "vitest";
import {
  CONVERSATION_ATTACHMENT_BUDGET,
  MAX_IMAGES_PER_MESSAGE,
  attachmentSupport,
  enforceAttachmentBudget,
  onlyNewestAttachments,
  parseStoredAttachment,
  validateAttachments,
  withoutUnsupported,
} from "../app/main/services/chat/chatAttachments";
import type { ChatAttachment } from "../app/main/ipc";
import { toAnthropicMessages, toOpenAiMessages, toWire, type ChatEntry } from "../app/main/services/chat/transcript";
import { appendEntry, newConversation, parseConversation } from "../app/main/services/chat/transcriptStoreCore";
import { seedPrompt } from "../app/main/services/chat/agents/types";

const PNG = "iVBORw0KGgo=";
const PDF = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
const name = (s: string, t: string) => `${s}__${t}`;

const png = (id = "i1"): ChatAttachment => ({ id, kind: "image", mimeType: "image/png", dataBase64: PNG });
const pdf = (id = "p1"): ChatAttachment => ({ id, kind: "pdf", mimeType: "application/pdf", name: "spec.pdf", dataBase64: PDF });

describe("validateAttachments", () => {
  it("accepts images and PDFs and derives the kind", () => {
    const out = validateAttachments([{ mimeType: "image/png", dataBase64: PNG }, { mimeType: "application/pdf", dataBase64: PDF, name: " spec.pdf " }]);
    expect(out).toEqual({
      ok: true,
      attachments: [
        { kind: "image", mimeType: "image/png", dataBase64: PNG },
        { kind: "pdf", mimeType: "application/pdf", dataBase64: PDF, name: "spec.pdf" },
      ],
    });
  });
  it("treats absence as no attachments", () => {
    expect(validateAttachments(undefined)).toEqual({ ok: true, attachments: [] });
  });
  it.each([
    ["svg", [{ mimeType: "image/svg+xml", dataBase64: PNG }]],
    ["bad base64", [{ mimeType: "image/png", dataBase64: "not base64!" }]],
    ["empty", [{ mimeType: "image/png", dataBase64: "" }]],
    ["a renamed text file", [{ mimeType: "application/pdf", dataBase64: Buffer.from("hello world").toString("base64") }]],
    ["not a list", { mimeType: "image/png" }],
    ["a non-object", [42]],
  ])("refuses %s", (_label, raw) => {
    expect(validateAttachments(raw).ok).toBe(false);
  });
  it("refuses a message with too many images, and an oversize PDF", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({ mimeType: "image/png", dataBase64: PNG }));
    expect(validateAttachments(many).ok).toBe(false);
    const huge = "JVBERi0".padEnd(8 * 1024 * 1024, "A");
    expect(validateAttachments([{ mimeType: "application/pdf", dataBase64: huge }])).toMatchObject({ ok: false });
  });
});

describe("attachmentSupport", () => {
  it("matrix", () => {
    expect(attachmentSupport("anthropic", "image", false)).toBeNull();
    expect(attachmentSupport("anthropic", "pdf", false)).toBeNull();
    for (const gateway of ["openai", "opencode-zen", "opencode-go"]) {
      expect(attachmentSupport(gateway, "image", false)).toBe("gatewayOptIn");
      expect(attachmentSupport(gateway, "image", true)).toBeNull();
      expect(attachmentSupport(gateway, "pdf", true)).toBe("pdfNeedsMcp");
    }
    for (const runtime of ["codex", "claude-code"]) {
      expect(attachmentSupport(runtime, "image", true)).toBe("subscription");
      expect(attachmentSupport(runtime, "pdf", true)).toBe("subscription");
    }
  });
});

describe("stored attachments", () => {
  it("round-trips through the conversation file at version 1", () => {
    const convo = newConversation("c1", 1);
    appendEntry(convo, { kind: "user", text: "look", attachments: [png(), pdf()] }, 2);
    const parsed = parseConversation(JSON.parse(JSON.stringify(convo)))!;
    expect(parsed.entries[0]).toEqual({ kind: "user", text: "look", attachments: [png(), pdf()] });
    expect(parsed.version).toBe(1);
  });
  it("a damaged file costs the file, not the message", () => {
    const convo = newConversation("c1", 1);
    appendEntry(convo, { kind: "user", text: "look", attachments: [png(), { ...png("bad"), dataBase64: "@@@" }] }, 2);
    const parsed = parseConversation(JSON.parse(JSON.stringify(convo)))!;
    expect(parsed.entries[0]).toEqual({ kind: "user", text: "look", attachments: [png()] });
    expect(parseStoredAttachment({ id: "x", mimeType: "image/svg+xml", dataBase64: PNG })).toBeUndefined();
  });
  it("names an attachment-only conversation from its first file", () => {
    const convo = newConversation("c1", 1);
    appendEntry(convo, { kind: "user", text: "", attachments: [pdf()] }, 2);
    expect(convo.title).toBe("spec.pdf");
  });
});

describe("enforceAttachmentBudget", () => {
  const big = (id: string, n: number): ChatAttachment => ({ ...png(id), dataBase64: "A".repeat(n) });
  it("evicts the oldest message's files first and marks the bubble", () => {
    const entries: any[] = [
      { kind: "user", text: "a", attachments: [big("1", 10)] },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "b", attachments: [big("2", 10)] },
    ];
    const dropped = enforceAttachmentBudget(entries, 15);
    expect(dropped).toBe(1);
    expect(entries[0].attachments).toBeUndefined();
    expect(entries[0].attachmentsEvicted).toBe(1);
    expect(entries[2].attachments).toHaveLength(1);
  });
  it("never evicts the newest message, and does nothing within budget", () => {
    const entries: any[] = [{ kind: "user", text: "b", attachments: [big("2", 100)] }];
    expect(enforceAttachmentBudget(entries, 10)).toBe(0);
    expect(entries[0].attachments).toHaveLength(1);
    expect(CONVERSATION_ATTACHMENT_BUDGET).toBeGreaterThan(12 * 1024 * 1024);
  });
});

describe("converters", () => {
  const entries: ChatEntry[] = [{ kind: "user", text: "what is this?", attachments: [png(), pdf()] }];

  it("Anthropic: image and document blocks lead the text", () => {
    expect(toAnthropicMessages(entries, name)[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF }, title: "spec.pdf" },
      { type: "text", text: "what is this?" },
    ]);
  });
  it("Anthropic: an attachment-only message has no empty text block", () => {
    const blocks = toAnthropicMessages([{ kind: "user", text: "", attachments: [png()] }], name)[0].content;
    expect(blocks.map((b) => b.type)).toEqual(["image"]);
  });
  it("OpenAI: text-only requests stay a plain string", () => {
    expect(toOpenAiMessages([{ kind: "user", text: "hi" }], name)).toEqual([{ role: "user", content: "hi" }]);
  });
  it("OpenAI: images become image_url parts, PDFs are never emitted", () => {
    expect(toOpenAiMessages(entries, name)[0]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        { type: "text", text: "what is this?" },
      ],
    });
  });
  it("round-trips through JSON to identical requests", () => {
    const again = JSON.parse(JSON.stringify(entries)) as ChatEntry[];
    expect(toAnthropicMessages(again, name)).toEqual(toAnthropicMessages(entries, name));
  });
});

describe("wire and request shaping", () => {
  it("toWire carries no bytes", () => {
    const wire = toWire({ kind: "user", text: "x", attachments: [png(), pdf()] });
    expect(JSON.stringify(wire)).not.toContain(PNG);
    expect(wire).toMatchObject({ kind: "user", attachments: [{ id: "i1", kind: "image" }, { id: "p1", kind: "pdf", name: "spec.pdf" }] });
  });
  it("withoutUnsupported replaces files with a note and never mutates", () => {
    const entries: ChatEntry[] = [{ kind: "user", text: "see", attachments: [png(), pdf()] }];
    const out = withoutUnsupported(entries, (k) => k === "image", "was left out");
    expect(out[0]).toMatchObject({ attachments: [png()] });
    expect((out[0] as any).text).toContain("1 PDF attached here was left out");
    expect((entries[0] as any).attachments).toHaveLength(2);
    expect(withoutUnsupported(entries, () => true, "x")[0]).toBe(entries[0]);
  });
  it("onlyNewestAttachments keeps the newest message's files", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "old", attachments: [png("a")] },
      { kind: "user", text: "new", attachments: [png("b")] },
    ];
    const out = onlyNewestAttachments(entries) as any[];
    expect(out[0].attachments).toBeUndefined();
    expect(out[0].text).toContain("earlier were left out");
    expect(out[1].attachments).toHaveLength(1);
  });
  it("seedPrompt for a subscription runtime holds no file bytes", () => {
    expect(seedPrompt([{ kind: "user", text: "see", attachments: [png(), pdf()] }])).not.toContain(PNG);
  });
});
