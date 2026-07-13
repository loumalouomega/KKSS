/**
 * Generic OpenAI-compatible provider: raw fetch against
 * {baseUrl}/chat/completions with SSE streaming and function tool-calling.
 * Works with OpenAI, Ollama, OpenRouter and other compatible gateways —
 * no SDK dependency. The SSE parsing and tool-call delta accumulation are
 * exported as pure functions so the vitest glue tests can cover them.
 */
import { toOpenAiMessages } from "../transcript";
import { Provider, ProviderError, StreamTurnOptions, ToolCallRequest, TurnResult } from "./types";

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

export function createOpenAiCompatProvider(config: { baseUrl: string; apiKey?: string }): Provider {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async streamTurn(options: StreamTurnOptions): Promise<TurnResult> {
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
        throw new ProviderError("other", `Request failed (${response.status}): ${body}`);
      }
      if (!response.body) throw new ProviderError("other", "Response had no body");

      const parser = createSseParser();
      const toolCalls: ToolCallAccumulator = {};
      let text = "";
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          if (payload === "[DONE]") continue;
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
      return { text, toolCalls: finishToolCalls(toolCalls) };
    },
  };
}
