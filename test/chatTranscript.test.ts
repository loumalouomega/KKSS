import { describe, expect, it } from "vitest";
import {
  ChatEntry,
  toAnthropicMessages,
  toOpenAiMessages,
  toWire,
  truncate,
  PREVIEW_CHARS,
} from "../app/main/services/chat/transcript";

const name = (server: string, tool: string) => `${server}__${tool}`;

const toolTurn: ChatEntry[] = [
  { kind: "user", text: "mesh the model" },
  { kind: "assistant", text: "Meshing now." },
  { kind: "toolCall", callId: "c1", server: "cad", tool: "generate_mesh", argsJson: '{"path":"/m.stp"}' },
  { kind: "toolResult", callId: "c1", ok: true, text: "4320 nodes" },
  { kind: "assistant", text: "Done: 4320 nodes." },
];

describe("toAnthropicMessages", () => {
  it("pairs tool_use with tool_result in the single following user message", () => {
    const messages = toAnthropicMessages(toolTurn, name);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const assistant = messages[1];
    expect(assistant.content).toEqual([
      { type: "text", text: "Meshing now." },
      { type: "tool_use", id: "c1", name: "cad__generate_mesh", input: { path: "/m.stp" } },
    ]);
    expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "4320 nodes" }]);
  });

  it("marks failed tool results with is_error", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "go" },
      { kind: "toolCall", callId: "c1", server: "mesh", tool: "mesh_info", argsJson: "{}" },
      { kind: "toolResult", callId: "c1", ok: false, text: "no such file" },
    ];
    const messages = toAnthropicMessages(entries, name);
    expect(messages[2].content[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("drops tool calls left unanswered by an abort", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "go" },
      { kind: "assistant", text: "Working." },
      { kind: "toolCall", callId: "dangling", server: "cad", tool: "load_model", argsJson: "{}" },
      { kind: "user", text: "try again" },
    ];
    const messages = toAnthropicMessages(entries, name);
    expect(JSON.stringify(messages)).not.toContain("dangling");
    // Assistant text survives; the two user texts stay separate messages.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("skips error entries and empty assistant turns, and starts with a user message", () => {
    const entries: ChatEntry[] = [
      { kind: "assistant", text: "", stopped: true },
      { kind: "error", message: "boom", errorKind: "other" },
      { kind: "user", text: "hello" },
    ];
    const messages = toAnthropicMessages(entries, name);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it("merges consecutive user entries into one message", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "first" },
      { kind: "user", text: "second" },
    ];
    const messages = toAnthropicMessages(entries, name);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toHaveLength(2);
  });
});

describe("toOpenAiMessages", () => {
  it("emits assistant tool_calls followed by role:tool results", () => {
    const messages = toOpenAiMessages(toolTurn, name);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const assistant = messages[1] as Extract<(typeof messages)[1], { role: "assistant" }>;
    expect(assistant.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "cad__generate_mesh", arguments: '{"path":"/m.stp"}' } },
    ]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "4320 nodes" });
  });

  it("drops unanswered tool calls", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "go" },
      { kind: "toolCall", callId: "dangling", server: "cad", tool: "load_model", argsJson: "{}" },
    ];
    expect(JSON.stringify(toOpenAiMessages(entries, name))).not.toContain("dangling");
  });
});

describe("wire form", () => {
  it("truncates tool results to a preview", () => {
    const long = "x".repeat(PREVIEW_CHARS + 100);
    const wire = toWire({ kind: "toolResult", callId: "c1", ok: true, text: long });
    expect(wire.kind).toBe("toolResult");
    if (wire.kind === "toolResult") {
      expect(wire.preview.length).toBeLessThan(long.length);
      expect(wire.preview).toContain("[truncated");
    }
  });

  it("truncate keeps short strings untouched", () => {
    expect(truncate("short", 100)).toBe("short");
  });
});
