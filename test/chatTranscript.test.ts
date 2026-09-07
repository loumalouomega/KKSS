import { describe, expect, it } from "vitest";
import {
  ChatEntry,
  PREVIEW_CHARS,
  toAnthropicMessages,
  toOpenAiMessages,
  toWire,
  truncate,
} from "../app/main/services/chat/transcript";
import { applyCompaction, CLEARED_PLACEHOLDER } from "../app/main/services/chat/compaction";
import { parseConversation, newConversation, appendEntry } from "../app/main/services/chat/transcriptStoreCore";

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

describe("a conversation that came back off disk", () => {
  it("converts identically — persistence is not a second truncation point", () => {
    const long = "n".repeat(PREVIEW_CHARS * 3);
    const entries: ChatEntry[] = [
      ...toolTurn.slice(0, 3),
      { kind: "toolResult", callId: "c1", ok: true, text: long },
      { kind: "assistant", text: "Done." },
    ];
    const convo = newConversation("c1", 0);
    for (const entry of entries) appendEntry(convo, entry, 1);

    const restored = parseConversation(JSON.parse(JSON.stringify(convo)))!.entries;

    expect(toAnthropicMessages(restored, name)).toEqual(toAnthropicMessages(entries, name));
    expect(toOpenAiMessages(restored, name)).toEqual(toOpenAiMessages(entries, name));
    // The wire form is still the only place anything is shortened.
    const wire = toWire(restored[3]);
    expect(wire.kind === "toolResult" && wire.preview).toContain("[truncated");
  });
});

describe("a denied tool call", () => {
  /** What the approval gate appends when the user says no: the call is
   *  annotated, and a synthetic failed result stands in for the run. */
  const deniedTurn: ChatEntry[] = [
    { kind: "user", text: "overwrite the mesh" },
    { kind: "assistant", text: "Transforming." },
    {
      kind: "toolCall",
      callId: "c1",
      server: "mesh",
      tool: "mesh_transform",
      argsJson: '{"path":"/a.mdpa"}',
      approval: "denied",
    },
    { kind: "toolResult", callId: "c1", ok: false, text: "Denied by the user." },
  ];

  it("still reaches Anthropic as a matched tool_use / tool_result pair", () => {
    // This is the whole reason a denial synthesizes a result: toAnthropicMessages
    // drops a tool_use with no matching tool_result, so a silent denial would
    // vanish from the request and the model would re-emit the same call.
    const messages = toAnthropicMessages(deniedTurn, name);
    const assistant = messages[1];
    expect(assistant.content).toContainEqual({
      type: "tool_use",
      id: "c1",
      name: "mesh__mesh_transform",
      input: { path: "/a.mdpa" },
    });
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "Denied by the user.", is_error: true },
    ]);
  });

  it("still reaches an OpenAI-compatible backend as a tool message", () => {
    const messages = toOpenAiMessages(deniedTurn, name);
    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "c1", content: "Denied by the user." });
  });

  it("passes the decision through toWire untouched", () => {
    // toolCall is forwarded by identity, which is only sound while ChatEntry
    // and ChatWireEntry stay field-identical for that kind.
    expect(toWire(deniedTurn[2])).toEqual(deniedTurn[2]);
  });
});

describe("compaction is structurally invisible to both wire formats", () => {
  const entries: ChatEntry[] = [
    { kind: "user", text: "inspect the model" },
    { kind: "assistant", text: "looking" },
    { kind: "toolCall", callId: "c1", server: "cad", tool: "inspect", argsJson: '{"path":"/a.stp"}' },
    { kind: "toolResult", callId: "c1", ok: true, text: "a very long inspection report" },
    { kind: "user", text: "and the mesh?" },
    { kind: "assistant", text: "checking" },
    { kind: "toolCall", callId: "c2", server: "mesh", tool: "mesh_info", argsJson: "{}" },
    { kind: "toolResult", callId: "c2", ok: false, text: "it failed" },
  ];

  it("keeps the Anthropic message shape identical — only tool_result content moves", () => {
    // This is the claim the whole design rests on: clearing a result's text
    // cannot drop a message, reorder roles, or unpair a tool_use.
    const before = toAnthropicMessages(entries, name);
    const after = toAnthropicMessages(applyCompaction(entries, 9), name);
    const shape = (messages: ReturnType<typeof toAnthropicMessages>) =>
      messages.map((m) => ({ role: m.role, blocks: m.content.map((b) => [b.type, "id" in b ? b.id : "tool_use_id" in b ? b.tool_use_id : null]) }));
    expect(shape(after)).toEqual(shape(before));
  });

  it("keeps the OpenAI message shape identical too", () => {
    const shape = (messages: ReturnType<typeof toOpenAiMessages>) =>
      messages.map((m) => ({ role: m.role, calls: "tool_calls" in m ? m.tool_calls?.map((c) => c.id) : undefined }));
    expect(shape(toOpenAiMessages(applyCompaction(entries, 9), name))).toEqual(shape(toOpenAiMessages(entries, name)));
  });

  it("clears a successful result and leaves a failed one — is_error survives", () => {
    const messages = toAnthropicMessages(applyCompaction(entries, 9), name);
    const results = messages.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
    expect(results[0]).toMatchObject({ tool_use_id: "c1", content: CLEARED_PLACEHOLDER });
    expect(results[1]).toMatchObject({ tool_use_id: "c2", content: "it failed", is_error: true });
  });
});

describe("a transcript that starts mid-tool-turn", () => {
  // What capEntries used to be able to produce by trimming the front of a long
  // conversation. Anthropic rejects a first message whose leading block is a
  // tool_result, so it must never be emitted.
  const orphaned: ChatEntry[] = [
    { kind: "toolCall", callId: "c1", server: "cad", tool: "inspect", argsJson: "{}" },
    { kind: "toolResult", callId: "c1", ok: true, text: "output" },
    { kind: "user", text: "carry on" },
    { kind: "assistant", text: "sure" },
  ];

  it("never begins with a user message carrying a tool_result", () => {
    const messages = toAnthropicMessages(orphaned, name);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.some((b) => b.type === "tool_result")).toBe(false);
    expect(messages[0].content).toEqual([{ type: "text", text: "carry on" }]);
  });

  it("drops an entry list that is nothing but an orphaned tool turn", () => {
    expect(toAnthropicMessages(orphaned.slice(0, 2), name)).toEqual([]);
  });
});
