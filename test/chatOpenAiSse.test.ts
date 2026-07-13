import { describe, expect, it } from "vitest";
import {
  accumulateToolCallDeltas,
  createSseParser,
  finishToolCalls,
  ToolCallAccumulator,
} from "../app/main/services/chat/providers/openaiCompat";

describe("createSseParser", () => {
  it("extracts data payloads from complete events", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("buffers events split across chunk boundaries", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"part"')).toEqual([]);
    expect(parser.push(':1}\n\n')).toEqual(['{"part":1}']);
  });

  it("handles CRLF line endings and [DONE]", () => {
    const parser = createSseParser();
    expect(parser.push("data: [DONE]\r\n\r\n")).toEqual(["[DONE]"]);
  });

  it("ignores comment/other fields and joins multi-line data", () => {
    const parser = createSseParser();
    expect(parser.push(": keep-alive\n\n")).toEqual([]);
    expect(parser.push("event: x\ndata: 1\ndata: 2\n\n")).toEqual(["1\n2"]);
  });
});

describe("tool call delta accumulation", () => {
  it("assembles a call streamed across chunks", () => {
    const acc: ToolCallAccumulator = {};
    accumulateToolCallDeltas(acc, [{ index: 0, id: "call_1", function: { name: "cad__load", arguments: "" } }]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: '{"path":' } }]);
    accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: '"/m.stp"}' } }]);
    expect(finishToolCalls(acc)).toEqual([{ id: "call_1", name: "cad__load", argsJson: '{"path":"/m.stp"}' }]);
  });

  it("keeps parallel calls separate and ordered by index", () => {
    const acc: ToolCallAccumulator = {};
    accumulateToolCallDeltas(acc, [
      { index: 1, id: "b", function: { name: "two", arguments: "{}" } },
      { index: 0, id: "a", function: { name: "one", arguments: "{}" } },
    ]);
    expect(finishToolCalls(acc).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("defaults empty arguments to {} and drops nameless slots", () => {
    const acc: ToolCallAccumulator = {};
    accumulateToolCallDeltas(acc, [{ index: 0, id: "a", function: { name: "tool" } }]);
    accumulateToolCallDeltas(acc, [{ index: 1, id: "b" }]); // never gets a name
    expect(finishToolCalls(acc)).toEqual([{ id: "a", name: "tool", argsJson: "{}" }]);
  });
});
