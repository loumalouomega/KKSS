/**
 * The pure half of chat transcript persistence: what a stored conversation is,
 * how it is serialized, how it degrades when the file on disk was written by
 * another version (or hand-edited), and the caps that keep the store bounded.
 *
 * No `electron` and no `node:fs`, so the decisions that actually cost user data
 * — what a damaged blob does, what gets evicted when the caps bite, how a
 * title is derived — are vitest-testable. `transcriptStore.ts` is the fs glue,
 * the same split as sessionCore.ts/session.ts and secretCodec.ts/secrets.ts.
 *
 * One rule the whole file exists to protect: a stored entry keeps the **full**
 * tool-result text the model was given. Truncation is a wire concern only
 * (transcript.ts's toWire/PREVIEW_CHARS), and this must never become a second
 * truncation point — a persisted transcript that silently shortened its own
 * tool results would change what a resumed conversation means to the model.
 */
import type { ChatErrorKind } from "../../ipc";
import type { ChatEntry } from "./transcript";

/** Bumped when the stored shape changes; another version is ignored wholesale
 *  rather than migrated, since a conversation is cheap to lose next to the risk
 *  of half-migrating one. Applies to both files. */
export const CHAT_STORE_VERSION = 1;

/** Each file holds a single JsonStore key, so the blob is one value. */
export const CHAT_INDEX_KEY = "index";
export const CONVERSATION_KEY = "conversation";

/** Least-recently-updated conversations are evicted past this. */
export const MAX_CONVERSATIONS = 50;
/** A runaway agent loop must not grow one file without bound. */
export const CONVERSATION_ENTRY_CAP = 2000;

export const TITLE_CHARS = 60;
export const DEFAULT_TITLE = "New conversation";

/** An index row — everything the sidebar list needs without opening the file. */
export interface ConversationMeta {
  id: string;
  title: string;
  /** Epoch ms. The renderer formats the relative time itself, so a popover
   *  left open does not go stale. */
  createdAt: number;
  updatedAt: number;
  entryCount: number;
}

export interface StoredIndex {
  version: number;
  /** Newest-updated first. */
  conversations: ConversationMeta[];
  activeId: string | null;
}

export interface StoredConversation {
  version: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: ChatEntry[];
}

/**
 * The in-memory conversation the agent loop writes into. `alive` goes false the
 * moment it is deleted, so a turn that is still unwinding cannot append to a
 * conversation the user just removed — and so recreate its file.
 */
export interface LiveConversation extends StoredConversation {
  alive: boolean;
}

export function newConversation(id: string, now: number): LiveConversation {
  return { version: CHAT_STORE_VERSION, id, title: DEFAULT_TITLE, createdAt: now, updatedAt: now, entries: [], alive: true };
}

/** Nothing worth persisting — an untouched "New" conversation. */
export function isEmptyConversation(convo: StoredConversation): boolean {
  return convo.entries.length === 0;
}

// ---- parsing ---------------------------------------------------------------

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === "object" && !Array.isArray(raw);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const ERROR_KINDS: ChatErrorKind[] = ["auth", "network", "noKey", "other"];

/**
 * One entry, or `undefined` if it is damaged beyond use. Repairing rather than
 * rejecting the whole file matters: a single bad entry in a long conversation
 * should cost that entry, not the record of everything the assistant did.
 */
function parseEntry(raw: unknown): ChatEntry | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case "user": {
      const text = str(raw.text);
      return text === undefined ? undefined : { kind: "user", text };
    }
    case "assistant": {
      const text = str(raw.text);
      if (text === undefined) return undefined;
      return raw.stopped === true ? { kind: "assistant", text, stopped: true } : { kind: "assistant", text };
    }
    case "toolCall": {
      const callId = str(raw.callId);
      const argsJson = str(raw.argsJson);
      if (callId === undefined || argsJson === undefined) return undefined;
      // The approval decision is optional, which is why adding it needed no
      // CHAT_STORE_VERSION bump: a bump discards every stored conversation
      // wholesale (see the constant), while an unknown field degrades in both
      // directions — an older build drops it and keeps the call, a newer one
      // reads an older file and simply sees `undefined`. A malformed value
      // costs the annotation, never the entry.
      const approval = raw.approval === "allowed" || raw.approval === "denied" ? raw.approval : undefined;
      const entry: ChatEntry = {
        kind: "toolCall",
        callId,
        server: str(raw.server) ?? "",
        tool: str(raw.tool) ?? "",
        argsJson,
      };
      return approval ? { ...entry, approval } : entry;
    }
    case "toolResult": {
      const callId = str(raw.callId);
      const text = str(raw.text);
      if (callId === undefined || text === undefined) return undefined;
      return { kind: "toolResult", callId, ok: raw.ok === true, text };
    }
    case "error": {
      const message = str(raw.message);
      if (message === undefined) return undefined;
      const kind = raw.errorKind;
      return { kind: "error", message, errorKind: ERROR_KINDS.includes(kind as ChatErrorKind) ? (kind as ChatErrorKind) : "other" };
    }
    default:
      return undefined;
  }
}

/** Reads a stored conversation, or `undefined` if it is missing, damaged, or
 *  from a different version — the glue then prunes its index row. */
export function parseConversation(raw: unknown): StoredConversation | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== CHAT_STORE_VERSION) return undefined;
  const id = str(raw.id);
  if (!id) return undefined;
  const createdAt = num(raw.createdAt, 0);
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(parseEntry).filter((e): e is ChatEntry => !!e)
    : [];
  return {
    version: CHAT_STORE_VERSION,
    id,
    title: str(raw.title) || DEFAULT_TITLE,
    createdAt,
    updatedAt: num(raw.updatedAt, createdAt),
    entries: capEntries(entries, CONVERSATION_ENTRY_CAP),
  };
}

function parseMeta(raw: unknown): ConversationMeta | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  if (!id) return undefined;
  const createdAt = num(raw.createdAt, 0);
  return {
    id,
    title: str(raw.title) || DEFAULT_TITLE,
    createdAt,
    updatedAt: num(raw.updatedAt, createdAt),
    entryCount: Math.max(0, Math.trunc(num(raw.entryCount, 0))),
  };
}

/** Reads the index. Unlike a conversation this never fails: an empty index is a
 *  valid state, and "no history" is the honest reading of a damaged one. */
export function parseIndex(raw: unknown): StoredIndex {
  const empty: StoredIndex = { version: CHAT_STORE_VERSION, conversations: [], activeId: null };
  if (!isRecord(raw) || raw.version !== CHAT_STORE_VERSION) return empty;
  const seen = new Set<string>();
  const conversations: ConversationMeta[] = [];
  for (const row of Array.isArray(raw.conversations) ? raw.conversations : []) {
    const meta = parseMeta(row);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    conversations.push(meta);
  }
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  const activeId = str(raw.activeId);
  return {
    version: CHAT_STORE_VERSION,
    conversations,
    activeId: activeId && conversations.some((c) => c.id === activeId) ? activeId : null,
  };
}

// ---- index maintenance -----------------------------------------------------

export function metaFor(convo: StoredConversation): ConversationMeta {
  return {
    id: convo.id,
    title: convo.title,
    createdAt: convo.createdAt,
    updatedAt: convo.updatedAt,
    entryCount: convo.entries.length,
  };
}

/** Inserts or replaces a row, keeping the list newest-updated first. */
export function upsertMeta(index: StoredIndex, meta: ConversationMeta): StoredIndex {
  const conversations = [...index.conversations.filter((c) => c.id !== meta.id), meta].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  return { ...index, conversations };
}

/**
 * Drops rows whose file is gone — the cheap alternative to a transaction across
 * the two files. A crash between unlinking a conversation and rewriting the
 * index leaves a dangling row; so does a user clearing out the directory. Same
 * shape as sessionCore's pruneSession, and for the same reason: the read path
 * is where the world's having moved on is discovered.
 */
export function pruneIndex(index: StoredIndex, exists: (id: string) => boolean): StoredIndex {
  const conversations = index.conversations.filter((c) => exists(c.id));
  const activeId = index.activeId && conversations.some((c) => c.id === index.activeId) ? index.activeId : null;
  return { ...index, conversations, activeId };
}

/**
 * Keeps the `cap` most-recently-updated conversations. The active one is never
 * evicted — the user is looking at it, however old it is — so it takes a slot
 * out of the budget rather than being kept *over* it; the cap stays a cap.
 * Assumes the newest-first ordering parseIndex/upsertMeta maintain.
 */
export function capConversations(index: StoredIndex, cap: number): { index: StoredIndex; evicted: string[] } {
  if (index.conversations.length <= cap) return { index, evicted: [] };
  const active = index.conversations.find((c) => c.id === index.activeId);
  const budget = active ? cap - 1 : cap;
  const kept: ConversationMeta[] = [];
  const evicted: string[] = [];
  for (const meta of index.conversations) {
    if (meta === active) continue;
    if (kept.length < budget) kept.push(meta);
    else evicted.push(meta.id);
  }
  if (active) kept.push(active);
  kept.sort((a, b) => b.updatedAt - a.updatedAt);
  return { index: { ...index, conversations: kept }, evicted };
}

// ---- conversation mutation -------------------------------------------------

/** Drops the oldest entries past the cap. */
export function capEntries(entries: ChatEntry[], cap: number): ChatEntry[] {
  return entries.length <= cap ? entries : entries.slice(entries.length - cap);
}

/** The first user message names the conversation, the way a commit's subject
 *  names a commit. Later messages never rename it — a title that kept moving
 *  would make the history list unrecognizable. */
export function deriveTitle(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) return DEFAULT_TITLE;
  const collapsed = line.trim().replace(/\s+/g, " ");
  return collapsed.length <= TITLE_CHARS ? collapsed : `${collapsed.slice(0, TITLE_CHARS).trimEnd()}…`;
}

/** Appends an entry, bumps the timestamp, and titles the conversation on its
 *  first user message. The single mutation point, so nothing can append without
 *  the index row going stale. */
export function appendEntry(convo: LiveConversation, entry: ChatEntry, now: number): void {
  const firstUser = entry.kind === "user" && !convo.entries.some((e) => e.kind === "user");
  convo.entries.push(entry);
  if (convo.entries.length > CONVERSATION_ENTRY_CAP) convo.entries = capEntries(convo.entries, CONVERSATION_ENTRY_CAP);
  if (firstUser) convo.title = deriveTitle(entry.text);
  convo.updatedAt = now;
}

/**
 * Records an interrupted assistant turn honestly: whatever text had streamed so
 * far, flagged stopped. Deliberately an *append* rather than a flag set on the
 * previous entry — retro-flagging mislabels an already-finished turn when the
 * abort lands on iteration 2+ of the tool loop, and throws away the partial
 * text the user watched arrive.
 */
export function markStopped(convo: LiveConversation, partial: string, now: number): ChatEntry {
  const entry: ChatEntry = { kind: "assistant", text: partial, stopped: true };
  appendEntry(convo, entry, now);
  return entry;
}
