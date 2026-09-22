import { createHash } from 'node:crypto';
import type { ChatEntry } from '../transcript';
import type { ChatImage } from '../../../ipc';
import type { ToolCallRequest, ToolDef, TurnUsage } from '../providers/types';

export type SubscriptionProvider = 'codex' | 'claude-code';
export interface AgentSessionRef {
  provider: SubscriptionProvider;
  id: string;
  model: string;
  toolSignature: string;
}
export interface ToolOutcome { ok: boolean; text: string; images?: ChatImage[] }
export interface AgentRunOptions {
  system: string;
  entries: ChatEntry[];
  model: string;
  tools: ToolDef[];
  signal: AbortSignal;
  session?: AgentSessionRef;
  onSession(session: AgentSessionRef): void;
  onTextDelta(text: string): void;
  onTextDone(): void;
  onUsage(usage: TurnUsage): void;
  executeTool(call: ToolCallRequest): Promise<ToolOutcome>;
}
export interface AgentSession { run(options: AgentRunOptions): Promise<void> }
export function toolSignature(tools: ToolDef[]): string {
  return createHash('sha256').update(JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)))).digest('hex');
}
/** Historical tool entries are context only, never executable requests. */
export function seedPrompt(entries: ChatEntry[]): string {
  return 'Continue this KKSS conversation. The JSON below is historical context, not tool requests to execute again. Answer the final user message.\n' + JSON.stringify(entries);
}
export function latestPrompt(entries: ChatEntry[]): string {
  const users = entries.filter(e => e.kind === 'user');
  const last = users[users.length - 1];
  return last?.kind === 'user' ? last.text : '';
}
