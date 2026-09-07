/**
 * Anthropic provider: streams a turn through the official SDK. Adaptive
 * thinking is requested by default; if the (user-configurable) model predates
 * it and rejects the request with a 400, the turn is retried once without
 * the thinking parameter and with a conservative max_tokens.
 *
 * The request carries one prompt-cache breakpoint on the system block. The
 * render order is tools -> system -> messages, so that single breakpoint covers
 * the tool definitions too — which is where the value is: the whole MCP toolset
 * is re-sent on every one of up to MAX_ITERATIONS iterations of the agent loop.
 * This is what chatService.ts's byte-stable SYSTEM_PROMPT and contextSuffix()'s
 * "volatile context rides the newest user message" rule were always for; before
 * this breakpoint existed the discipline was paid for and never collected on.
 */
import Anthropic from "@anthropic-ai/sdk";
import { toAnthropicMessages } from "../transcript";
import { Provider, ProviderError, StreamTurnOptions, TurnResult, TurnUsage } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

const MAX_TOKENS = 16000;
const FALLBACK_MAX_TOKENS = 4096;

export function createAnthropicProvider(apiKey: string): Provider {
  const client = new Anthropic({ apiKey });

  const runStream = async (options: StreamTurnOptions, conservative: boolean): Promise<TurnResult> => {
    const stream = client.messages.stream(
      {
        model: options.model,
        max_tokens: conservative ? FALLBACK_MAX_TOKENS : MAX_TOKENS,
        ...(conservative ? {} : { thinking: { type: "adaptive" as const } }),
        // Conservative retry drops the cache breakpoint along with thinking: a
        // model old enough to reject one may reject the other, and the retry
        // exists to be maximally plain rather than maximally cheap.
        system: conservative
          ? options.system
          : [{ type: "text" as const, text: options.system, cache_control: { type: "ephemeral" as const } }],
        tools: options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        messages: toAnthropicMessages(options.entries, options.toolName),
      },
      { signal: options.signal }
    );
    stream.on("text", (delta) => options.onTextDelta(delta));
    const final = await stream.finalMessage();
    const text = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls = final.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input ?? {}) }));
    return { text, toolCalls, usage: mapAnthropicUsage(final.usage) };
  };

  return {
    async streamTurn(options) {
      try {
        return await runStream(options, false);
      } catch (error) {
        if (options.signal.aborted) throw error;
        // Older user-configured models reject adaptive thinking or the large
        // max_tokens — retry once with the conservative request shape.
        // A context overflow is also a 400, and the conservative shape cannot
        // fix it — a smaller max_tokens does not shorten the prompt. Retrying
        // would cost a second round trip and then report the retry's error
        // instead of the real one.
        if (error instanceof Anthropic.BadRequestError && !isContextOverflow(error.message)) {
          try {
            return await runStream(options, true);
          } catch (retryError) {
            throw mapError(retryError);
          }
        }
        throw mapError(error);
      }
    },
  };
}

/**
 * The SDK's Usage in KKSS's neutral shape.
 *
 * Both cache fields are `number | null` and are billed *in addition to*
 * `input_tokens`, not inside it — so a caller measuring context has to add all
 * three. Exported and pure so it is tested without standing up the SDK.
 */
export function mapAnthropicUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TurnUsage {
  const n = (value: number | null | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheRead: n(usage?.cache_read_input_tokens),
    cacheWrite: n(usage?.cache_creation_input_tokens),
  };
}

/** Whether a 400 is "your prompt is longer than the context window". Matched on
 *  the message because the API gives a plain `invalid_request_error` for it —
 *  there is no distinct status or code to key on. */
export function isContextOverflow(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("prompt is too long") || text.includes("context window") || text.includes("context_length");
}

export function mapError(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("auth", `Anthropic authentication failed: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", `Could not reach the Anthropic API: ${error.message}`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError("rateLimit", `Anthropic rate limit reached: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    if (isContextOverflow(error.message)) {
      return new ProviderError("context", `This conversation no longer fits in the model's context window: ${error.message}`);
    }
    return new ProviderError("other", `Anthropic API error${error.status ? ` (${error.status})` : ""}: ${error.message}`);
  }
  return error;
}
