import { describe, expect, it, vi, afterEach } from "vitest";
import type { StreamTurnOptions } from "../app/main/services/chat/providers/types";
import {
  buildOpenAiBody,
  accumulateToolCallDeltas,
  createOpenAiCompatProvider,
  createSseParser,
  finishToolCalls,
  parseUsageChunk,
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

describe("parseUsageChunk", () => {
  it("reads the trailing usage chunk, which carries no choices at all", () => {
    // The reason this is parsed before the stream loop's `delta` guard: that
    // guard skips any chunk without choices, which is exactly this one.
    const usage = parseUsageChunk('{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":340}}');
    expect(usage).toEqual({ input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 });
  });

  it("splits cached tokens out of prompt_tokens", () => {
    // OpenAI counts cached tokens inside prompt_tokens; Anthropic reports them
    // alongside. TurnUsage.input means uncached input on both.
    const usage = parseUsageChunk('{"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":800}}}');
    expect(usage).toEqual({ input: 200, output: 10, cacheRead: 800, cacheWrite: 0 });
  });

  it("never reports negative input if a gateway's figures disagree", () => {
    const usage = parseUsageChunk('{"usage":{"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":99}}}');
    expect(usage).toMatchObject({ input: 0, cacheRead: 99 });
  });

  it("returns null for a chunk that carries no usage", () => {
    expect(parseUsageChunk('{"choices":[{"delta":{"content":"hi"}}]}')).toBeNull();
    expect(parseUsageChunk('{"usage":null}')).toBeNull();
    expect(parseUsageChunk("not json")).toBeNull();
    expect(parseUsageChunk("[DONE]")).toBeNull();
  });

  it("treats missing or non-numeric fields as zero rather than NaN", () => {
    expect(parseUsageChunk('{"usage":{"prompt_tokens":"lots"}}')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("request headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const doneStream = () =>
    new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } });

  async function postHeaders(config: Parameters<typeof createOpenAiCompatProvider>[0], sessionId?: string) {
    let seen: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(doneStream(), { status: 200 });
    }));
    const provider = createOpenAiCompatProvider(config);
    await provider.streamTurn({
      system: "s", entries: [], tools: [], model: "m",
      signal: new AbortController().signal,
      onTextDelta: () => undefined,
      toolName: () => "x",
      ...(sessionId ? { sessionId } : {}),
    });
    return { url: seen!.url, headers: seen!.init.headers as Record<string, string> };
  }

  it("identifies OpenCode clients and pins the conversation for Go routing", async () => {
    const { url, headers } = await postHeaders(
      { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k", userAgent: "KKSS/0.0.0-test", sendSessionHeader: true },
      "convo-1",
    );
    expect(url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer k");
    expect(headers["user-agent"]).toBe("KKSS/0.0.0-test");
    expect(headers["x-opencode-session"]).toBe("convo-1");
  });

  it("never leaks the conversation id to a generic gateway", async () => {
    const { headers } = await postHeaders({ baseUrl: "http://localhost:11434/v1" }, "convo-1");
    expect(headers.authorization).toBeUndefined();
    expect(headers["user-agent"]).toBeUndefined();
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("optional request fields", () => {
  afterEach(() => vi.unstubAllGlobals());

  const opts = (extra: Partial<StreamTurnOptions> = {}): StreamTurnOptions => ({
    system: "s", entries: [], tools: [], model: "m",
    signal: new AbortController().signal,
    onTextDelta: () => undefined,
    toolName: () => "x",
    ...extra,
  });

  it("sends neither reasoning_effort nor max_tokens by default", () => {
    const body = buildOpenAiBody(opts(), true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect("reasoning_effort" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
    expect("reasoning_effort" in buildOpenAiBody(opts({ thinking: "auto" }), true)).toBe(false);
  });

  it("maps the thinking levels to reasoning_effort", () => {
    expect(buildOpenAiBody(opts({ thinking: "low" }), true).reasoning_effort).toBe("low");
    expect(buildOpenAiBody(opts({ thinking: "high" }), true).reasoning_effort).toBe("high");
    expect(buildOpenAiBody(opts({ thinking: "off" }), true).reasoning_effort).toBe("none");
  });

  it("sends max_tokens only when set to a positive number", () => {
    expect(buildOpenAiBody(opts({ maxOutputTokens: 2048 }), true).max_tokens).toBe(2048);
    expect("max_tokens" in buildOpenAiBody(opts({ maxOutputTokens: 0 }), true)).toBe(false);
  });

  it("drops every optional field together on the plain attempt", () => {
    const body = buildOpenAiBody(opts({ thinking: "high", maxOutputTokens: 100 }), false);
    for (const key of ["stream_options", "reasoning_effort", "max_tokens"]) expect(key in body).toBe(false);
    expect(body.model).toBe("m");
  });

  it("retries once without the extras when a gateway names one in its error", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response('{"error":"Unrecognized request argument: reasoning_effort"}', { status: 400 });
      return new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }), { status: 200 });
    }));
    const provider = createOpenAiCompatProvider({ baseUrl: "http://localhost:1/v1" });
    await provider.streamTurn(opts({ thinking: "low", maxOutputTokens: 500 }));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].reasoning_effort).toBe("low");
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(bodies[1].max_tokens).toBeUndefined();
    expect(bodies[1].stream_options).toBeUndefined();
  });

  it("does not retry an unrelated failure", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiCompatProvider({ baseUrl: "http://localhost:1/v1" });
    await expect(provider.streamTurn(opts({ thinking: "low" }))).rejects.toThrow(/Request failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
