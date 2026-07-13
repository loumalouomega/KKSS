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

export interface TurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
}

export type ProviderErrorKind = "auth" | "network" | "other";

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
