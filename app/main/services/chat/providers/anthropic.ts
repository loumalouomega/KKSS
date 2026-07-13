/**
 * Anthropic provider: streams a turn through the official SDK. Adaptive
 * thinking is requested by default; if the (user-configurable) model predates
 * it and rejects the request with a 400, the turn is retried once without
 * the thinking parameter and with a conservative max_tokens.
 */
import Anthropic from "@anthropic-ai/sdk";
import { toAnthropicMessages } from "../transcript";
import { Provider, ProviderError, StreamTurnOptions, TurnResult } from "./types";

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
        system: options.system,
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
    return { text, toolCalls };
  };

  return {
    async streamTurn(options) {
      try {
        return await runStream(options, false);
      } catch (error) {
        if (options.signal.aborted) throw error;
        // Older user-configured models reject adaptive thinking or the large
        // max_tokens — retry once with the conservative request shape.
        if (error instanceof Anthropic.BadRequestError) {
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

function mapError(error: unknown): unknown {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("auth", `Anthropic authentication failed: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", `Could not reach the Anthropic API: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderError("other", `Anthropic API error${error.status ? ` (${error.status})` : ""}: ${error.message}`);
  }
  return error;
}
