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

export interface StreamTurnOptions {
  system: string;
  entries: ChatEntry[];
  tools: ToolDef[];
  model: string;
  signal: AbortSignal;
  onTextDelta(text: string): void;
  /** Maps a tool call's (server, tool) back to the provider-facing name. */
  toolName(server: string, tool: string): string;
}

export interface Provider {
  /** Streams one model turn; resolves once the turn is complete. */
  streamTurn(options: StreamTurnOptions): Promise<TurnResult>;
}
