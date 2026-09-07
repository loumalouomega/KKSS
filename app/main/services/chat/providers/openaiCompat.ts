/**
 * Generic OpenAI-compatible provider: raw fetch against
 * {baseUrl}/chat/completions with SSE streaming and function tool-calling.
 * Works with OpenAI, Ollama, OpenRouter and other compatible gateways —
 * no SDK dependency. The SSE parsing and tool-call delta accumulation are
 * exported as pure functions so the vitest glue tests can cover them.
 */
import { toOpenAiMessages } from "../transcript";
import { Provider, ProviderError, StreamTurnOptions, ToolCallRequest, TurnResult, TurnUsage } from "./types";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/**
 * Incremental SSE parser: feed raw chunks, get back complete `data:` payloads.
 * Handles events split across chunk boundaries and CRLF line endings.
 */
export function createSseParser(): { push(chunk: string): string[] } {
  let buffer = "";
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const payloads: string[] = [];
      let index: number;
      while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, "");
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) payloads.push(data);
      }
      return payloads;
    },
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ToolCallAccumulator {
  [index: number]: { id: string; name: string; argsJson: string };
}

/** Merges one chunk's `delta.tool_calls` into the running accumulator. */
export function accumulateToolCallDeltas(acc: ToolCallAccumulator, deltas: ToolCallDelta[] | undefined): void {
  for (const delta of deltas ?? []) {
    const slot = (acc[delta.index] ??= { id: "", name: "", argsJson: "" });
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) slot.name += delta.function.name;
    if (delta.function?.arguments) slot.argsJson += delta.function.arguments;
  }
}

export function finishToolCalls(acc: ToolCallAccumulator): ToolCallRequest[] {
  return Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => {
      const slot = acc[index];
      return { id: slot.id || `call_${index}`, name: slot.name, argsJson: slot.argsJson || "{}" };
    })
    .filter((call) => call.name);
}

/**
 * The usage figures from one SSE payload, or `null` if it carries none.
 *
 * OpenAI sends usage in a final chunk with an **empty `choices` array**, which
 * is why the stream loop has to check for it before the `delta` guard that
 * skips choice-less chunks. Only sent at all when the request asked for it with
 * `stream_options.include_usage`.
 */
export function parseUsageChunk(payload: string): TurnUsage | null {
  let parsed: { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const usage = parsed?.usage;
  if (!usage || typeof usage !== "object") return null;
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cacheRead = n(usage.prompt_tokens_details?.cached_tokens);
  return {
    // prompt_tokens is the total including cached ones — the opposite of
    // Anthropic's split — so the cached part is subtracted back out to keep
    // TurnUsage.input meaning "uncached input" on both providers.
    input: Math.max(0, n(usage.prompt_tokens) - cacheRead),
    output: n(usage.completion_tokens),
    cacheRead,
    // No OpenAI-compatible API reports a cache *write* count; caching there is
    // automatic and unbilled rather than something the caller pays to create.
    cacheWrite: 0,
  };
}

export function createOpenAiCompatProvider(config: { baseUrl: string; apiKey?: string }): Provider {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async streamTurn(options: StreamTurnOptions): Promise<TurnResult> {
      // Gateways vary: `stream_options` is standard OpenAI, but a stricter
      // compatible server may reject the unknown field outright and take the
      // whole turn with it. Same shape as the Anthropic conservative retry —
      // ask for usage, and give it up rather than the turn.
      try {
        return await runStream(options, true);
      } catch (error) {
        if (options.signal.aborted) throw error;
        if (error instanceof ProviderError && error.kind === "other" && /stream_options/i.test(error.message)) {
          return runStream(options, false);
        }
        throw error;
      }
    },
  };

  async function runStream(options: StreamTurnOptions, askForUsage: boolean): Promise<TurnResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          stream: true,
          ...(askForUsage ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: "system", content: options.system }, ...toOpenAiMessages(options.entries, options.toolName)],
          ...(options.tools.length
            ? {
                tools: options.tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
              }
            : {}),
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new ProviderError("network", `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError("auth", `Authentication failed (${response.status}): ${body}`);
      }
      if (response.status === 429) {
        throw new ProviderError("rateLimit", `Rate limit reached (429): ${body}`);
      }
      // Not gated on 400: compatible gateways disagree about the status for an
      // over-length prompt (llama.cpp and vLLM have both returned 500). The
      // wording is the reliable signal, and is kept narrow — misclassifying some
      // other failure as a context overflow would trigger a pointless compaction
      // and retry.
      if (/context[_ ]length|maximum context|too many tokens/i.test(body)) {
        throw new ProviderError("context", `This conversation no longer fits in the model's context window: ${body}`);
      }
      throw new ProviderError("other", `Request failed (${response.status}): ${body}`);
    }
    if (!response.body) throw new ProviderError("other", "Response had no body");

    const parser = createSseParser();
    const toolCalls: ToolCallAccumulator = {};
    let usage: TurnUsage | undefined;
    let text = "";
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (payload === "[DONE]") continue;
        // Before the `delta` guard below: the usage chunk has no choices at
        // all, so that guard would drop it.
        usage = parseUsageChunk(payload) ?? usage;
        let parsed: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: ToolCallDelta[] } }> };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // tolerate keep-alives / malformed lines
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          options.onTextDelta(delta.content);
        }
        accumulateToolCallDeltas(toolCalls, delta.tool_calls);
      }
    }
    return { text, toolCalls: finishToolCalls(toolCalls), ...(usage ? { usage } : {}) };
  }
}
