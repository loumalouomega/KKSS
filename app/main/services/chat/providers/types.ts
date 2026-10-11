/** Provider-neutral surface the chat agent loop drives. */
import type { ChatEntry } from "../transcript";

/** A tool as advertised to the model (already namespaced, e.g. "cad__load_model"). */
export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool input (MCP inputSchema, passed through). */
  inputSchema: Record<string, unknown>;
}

/** One tool invocation requested by the model. */
export interface ToolCallRequest {
  id: string;
  name: string;
  argsJson: string;
}

/**
 * What one turn cost, as the provider reported it.
 *
 * `input` is the *uncached* input only: on Anthropic the two cache figures are
 * charged separately and are NOT included in `input_tokens`, so the number that
 * answers "how full is the context window" is the sum of all three, not `input`.
 * Absent entirely when the provider reports nothing (most OpenAI-compatible
 * gateways) — never zero-filled, so "no data" and "cost nothing" stay distinct.
 */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
  usage?: TurnUsage;
}

/** `context` = the request outgrew the model's window; `rateLimit` = 429. Both
 *  used to land in `other` and render as a banner with no actionable advice. */
export type ProviderErrorKind = "auth" | "network" | "context" | "rateLimit" | "other";

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Reasoning effort the user picked in the chat sidebar. `auto` = send nothing
 *  new (the provider's own default behaviour, byte-identical to before the
 *  control existed); `off` asks for no thinking where the API allows it. */
export type ThinkingLevel = "auto" | "off" | "low" | "high";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "off", "low", "high"];

export interface StreamTurnOptions {
  system: string;
  entries: ChatEntry[];
  tools: ToolDef[];
  model: string;
  signal: AbortSignal;
  onTextDelta(text: string): void;
  /** Maps a tool call's (server, tool) back to the provider-facing name. */
  toolName(server: string, tool: string): string;
  /** Stable per-conversation id. Sent as `x-opencode-session` by providers
   *  that ask for it (OpenCode Go uses it for routing and prompt caching);
   *  never sent to generic gateways. */
  sessionId?: string;
  /** Optional, user-chosen. Absent/`auto` leaves the request exactly as it was. */
  thinking?: ThinkingLevel;
  /** User-chosen output-token cap; absent = the provider's built-in default. */
  maxOutputTokens?: number;
}

export interface Provider {
  /** Streams one model turn; resolves once the turn is complete. */
  streamTurn(options: StreamTurnOptions): Promise<TurnResult>;
}
