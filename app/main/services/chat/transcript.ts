/**
 * Neutral chat transcript model + converters to the two provider wire
 * formats. Pure module (no electron/node imports) so the vitest glue tests
 * can exercise the conversion rules directly.
 *
 * Conversion rules that matter:
 *  - Anthropic requires every tool_use in an assistant turn to be answered
 *    by tool_result blocks in the single following user message; tool calls
 *    left dangling by an aborted run are dropped from requests.
 *  - Consecutive same-role messages are merged (tool_result blocks first).
 */
import type { ChatErrorKind, ChatWireEntry } from "../../ipc";

export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; stopped?: boolean }
  | { kind: "toolCall"; callId: string; server: string; tool: string; argsJson: string }
  | { kind: "toolResult"; callId: string; ok: boolean; text: string }
  | { kind: "error"; message: string; errorKind: ChatErrorKind };

/** Max characters of a tool result shown in the sidebar UI. */
export const PREVIEW_CHARS = 2000;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated, ${text.length - max} more characters]`;
}

/** Wire form of an entry (tool results carry a preview, not the full text). */
export function toWire(entry: ChatEntry): ChatWireEntry {
  if (entry.kind === "toolResult") {
    return { kind: "toolResult", callId: entry.callId, ok: entry.ok, preview: truncate(entry.text, PREVIEW_CHARS) };
  }
  return entry;
}

interface UserTurn {
  role: "user";
  texts: string[];
}
interface AssistantTurn {
  role: "assistant";
  text: string;
  calls: Array<{ callId: string; name: string; argsJson: string }>;
  results: Map<string, { ok: boolean; text: string }>;
}
type Turn = UserTurn | AssistantTurn;

/**
 * Groups entries into alternating user/assistant turns, attaching tool calls
 * and their results to the owning assistant turn. `toolName` maps a call's
 * (server, tool) to the provider-facing namespaced tool name.
 */
function groupTurns(entries: ChatEntry[], toolName: (server: string, tool: string) => string): Turn[] {
  const turns: Turn[] = [];
  const last = () => turns[turns.length - 1];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user": {
        const turn = last();
        if (turn && turn.role === "user") turn.texts.push(entry.text);
        else turns.push({ role: "user", texts: [entry.text] });
        break;
      }
      case "assistant":
        turns.push({ role: "assistant", text: entry.text, calls: [], results: new Map() });
        break;
      case "toolCall": {
        let turn = last();
        if (!turn || turn.role !== "assistant") {
          turn = { role: "assistant", text: "", calls: [], results: new Map() };
          turns.push(turn);
        }
        turn.calls.push({ callId: entry.callId, name: toolName(entry.server, entry.tool), argsJson: entry.argsJson });
        break;
      }
      case "toolResult": {
        for (let i = turns.length - 1; i >= 0; i--) {
          const turn = turns[i];
          if (turn.role === "assistant" && turn.calls.some((c) => c.callId === entry.callId)) {
            turn.results.set(entry.callId, { ok: entry.ok, text: entry.text });
            break;
          }
        }
        break;
      }
      case "error":
        break; // never sent to the model
    }
  }
  return turns;
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

// ---- Anthropic Messages API ------------------------------------------------

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

export function toAnthropicMessages(
  entries: ChatEntry[],
  toolName: (server: string, tool: string) => string
): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role) {
      // Merge consecutive same-role messages; tool_result blocks must lead.
      if (role === "user" && blocks.some((b) => b.type === "tool_result")) {
        prev.content = [...blocks.filter((b) => b.type === "tool_result"), ...prev.content, ...blocks.filter((b) => b.type !== "tool_result")];
      } else {
        prev.content.push(...blocks);
      }
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const turn of groupTurns(entries, toolName)) {
    if (turn.role === "user") {
      push(
        "user",
        turn.texts.map((text) => ({ type: "text" as const, text }))
      );
      continue;
    }
    // Drop tool calls that never got a result (aborted run) — Anthropic
    // rejects a tool_use with no matching tool_result in the next message.
    const answered = turn.calls.filter((c) => turn.results.has(c.callId));
    const blocks: AnthropicBlock[] = [];
    if (turn.text.trim()) blocks.push({ type: "text", text: turn.text });
    for (const call of answered) {
      blocks.push({ type: "tool_use", id: call.callId, name: call.name, input: parseArgs(call.argsJson) });
    }
    push("assistant", blocks);
    push(
      "user",
      answered.map((call) => {
        const result = turn.results.get(call.callId)!;
        return { type: "tool_result" as const, tool_use_id: call.callId, content: result.text, ...(result.ok ? {} : { is_error: true }) };
      })
    );
  }

  // The API requires the first message to be a user message.
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

// ---- OpenAI-compatible chat/completions ------------------------------------

export type OpenAiMessage =
  | { role: "user" | "system"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiMessages(
  entries: ChatEntry[],
  toolName: (server: string, tool: string) => string
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  for (const turn of groupTurns(entries, toolName)) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.texts.join("\n\n") });
      continue;
    }
    const answered = turn.calls.filter((c) => turn.results.has(c.callId));
    if (!turn.text.trim() && !answered.length) continue;
    messages.push({
      role: "assistant",
      content: turn.text.trim() ? turn.text : null,
      ...(answered.length
        ? {
            tool_calls: answered.map((call) => ({
              id: call.callId,
              type: "function" as const,
              function: { name: call.name, arguments: call.argsJson },
            })),
          }
        : {}),
    });
    for (const call of answered) {
      const result = turn.results.get(call.callId)!;
      messages.push({ role: "tool", tool_call_id: call.callId, content: result.text });
    }
  }
  return messages;
}
