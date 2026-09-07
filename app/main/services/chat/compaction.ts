/**
 * Request-side compaction: clearing old tool-result text so a long conversation
 * keeps fitting in the model's context window.
 *
 * Two things this deliberately is not.
 *
 * It is **not summarization**. Replacing only the `text` of a `toolResult` —
 * keeping the entry, its `callId` and its `ok` flag — is structurally invisible
 * to both wire formats: `groupTurns` matches a result to its call by `callId`
 * alone, the "answered" filter is a `Map.has`, and the resulting message list is
 * role-for-role identical, so nothing is dropped and the first-message-user trim
 * behaves exactly as before. Summarizing would mean removing entries, which
 * drags in a cut-point rule, an orphan-`tool_result` hazard, and a model call.
 * (Anthropic ships this same strategy server-side as context editing —
 * `clear_tool_uses`, with tool *inputs* a separate opt-in — which is independent
 * confirmation that results are the right thing to clear first.)
 *
 * It is **not a second truncation point for the stored transcript**. Everything
 * here runs on the copy `chatService.requestEntries()` builds; `convo.entries`,
 * the sidebar and `<id>.json` keep the full text. This is the one place where
 * what the model reads and what the user reads deliberately differ.
 *
 * Pure module (no electron/node) so the glue tests drive it directly.
 */
import type { ChatEntry } from "./transcript";

/**
 * Stands in for a cleared result.
 *
 * Non-empty on purpose: an empty `content` is rejected by some block shapes, and
 * `mcpManager` keeps the same habit with its "(empty result)" fallback. It also
 * carries the notice *in band* — which is what lets compaction ship without
 * touching `SYSTEM_PROMPT`, now that the prompt is a prompt-cache breakpoint.
 */
export const CLEARED_PLACEHOLDER =
  "[Older tool output was cleared to fit the context window. Re-run the tool if you still need this result.]";

/**
 * Whether this entry's text may be cleared.
 *
 * The single predicate `applyCompaction` and `nextCount` must both use: if they
 * ever disagree, an "advance" can select an entry that is then not cleared, and
 * the caller reads that as progress while re-sending an identical request.
 *
 * Only successful results qualify. A denied call's result carries the "do not
 * retry this" prose the approval gate depends on, and the placeholder says the
 * opposite — it would invite the model to re-run the very call the user refused,
 * re-opening the prompt. Failed results are short anyway, and their text is the
 * error the model needs in order to stop repeating itself.
 */
export function isClearable(entry: ChatEntry): boolean {
  return entry.kind === "toolResult" && entry.ok && entry.text !== CLEARED_PLACEHOLDER;
}

/** How many results are still holding full text. */
export function clearableCount(entries: readonly ChatEntry[]): number {
  return entries.reduce((total, entry) => total + (isClearable(entry) ? 1 : 0), 0);
}

/**
 * The entry list with the oldest `count` clearable results blanked.
 *
 * **Always allocates**, and replaces entries with fresh objects rather than
 * mutating them. Both halves matter: `requestEntries()` writes the context
 * suffix into whatever array it is handed, so returning the caller's own array
 * (the tempting `capEntries` fast-path idiom) would let that suffix accumulate
 * in the stored transcript, and mutating an entry in place would rewrite the
 * history the sidebar and the store are still holding.
 *
 * `count` is clamped, so a boundary that outlived the entries it described
 * clears everything rather than nothing — see `nextCount` for why that direction
 * is the safe one.
 */
export function applyCompaction(entries: readonly ChatEntry[], count: number): ChatEntry[] {
  const out = [...entries];
  if (count <= 0) return out;
  let remaining = count;
  for (let i = 0; i < out.length && remaining > 0; i++) {
    const entry = out[i];
    if (!isClearable(entry)) continue;
    out[i] = { ...entry, text: CLEARED_PLACEHOLDER } as ChatEntry;
    remaining--;
  }
  return out;
}

/**
 * The next boundary, or `null` when there is nothing left to clear.
 *
 * The boundary is a **count**, not a reference to a particular call. An id-based
 * anchor is wrong twice over here: it can vanish when `capEntries` trims the
 * front of a conversation, and tool-call ids are not unique on the
 * OpenAI-compatible path, where a gateway that streams no ids gets synthetic
 * `call_<index>` values that repeat every iteration. A count has no identity to
 * lose, and when it no longer matches the entries it simply clears more.
 *
 * That is the invariant worth stating: **a stale boundary must never clear less
 * than before.** Clearing too much costs the model some history it can re-fetch;
 * clearing too little silently restores the request that was already too big.
 *
 * Advances by halving what remains rather than by a fixed step. A fixed step
 * would keep firing whenever prose — not tool output — is what is filling the
 * window, blanking the entire tool history, after which the model does as the
 * placeholder invites and re-runs the tools, regrowing the context it just lost.
 */
export function nextCount(entries: readonly ChatEntry[], current: number): number | null {
  // `entries` is the stored transcript, which always holds full text — so this
  // is the total number of clearable results, and what is left to clear is
  // whatever the current boundary does not already cover.
  const remaining = clearableCount(entries) - current;
  if (remaining <= 0) return null;
  return current + Math.max(1, Math.ceil(remaining / 2));
}
