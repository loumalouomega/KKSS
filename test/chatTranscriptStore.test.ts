/**
 * transcriptStoreCore — what a persisted conversation is, and how it degrades.
 * The cases that matter are the ones where the file on disk was not written by
 * this build: another version, a hand-edit, a half-written array. Plus the one
 * property the whole store exists to protect — a stored tool result keeps its
 * full text, so the storage layer never becomes a second truncation point.
 */
import { describe, expect, it } from "vitest";
import {
  appendEntry,
  capConversations,
  capEntries,
  CHAT_STORE_VERSION,
  CONVERSATION_ENTRY_CAP,
  DEFAULT_TITLE,
  deriveTitle,
  isEmptyConversation,
  markStopped,
  metaFor,
  MAX_CONVERSATIONS,
  newConversation,
  parseConversation,
  parseIndex,
  pruneIndex,
  TITLE_CHARS,
  upsertMeta,
  type ConversationMeta,
  type StoredIndex,
} from "../app/main/services/chat/transcriptStoreCore";
import type { ChatEntry } from "../app/main/services/chat/transcript";

/** A conversation as it would come back off disk. */
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const meta = (id: string, updatedAt: number): ConversationMeta => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt,
  entryCount: 1,
});

/** `n` rows in the newest-first order the index is always kept in. */
const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => meta(`c${n - 1 - i}`, n - 1 - i));

const index = (conversations: ConversationMeta[], activeId: string | null = null): StoredIndex => ({
  version: CHAT_STORE_VERSION,
  conversations,
  activeId,
});

describe("parseConversation", () => {
  it("round-trips every entry kind through disk", () => {
    const convo = newConversation("c1", 1000);
    const entries: ChatEntry[] = [
      { kind: "user", text: "mesh this" },
      { kind: "assistant", text: "on it", stopped: true },
      { kind: "toolCall", callId: "t1", server: "mesh", tool: "mesh_info", argsJson: '{"path":"/a.mdpa"}' },
      { kind: "toolResult", callId: "t1", ok: false, text: "boom" },
      { kind: "error", message: "no key", errorKind: "noKey" },
    ];
    for (const entry of entries) appendEntry(convo, entry, 2000);

    const parsed = parseConversation(roundTrip(convo));
    expect(parsed?.entries).toEqual(entries);
    expect(parsed?.id).toBe("c1");
    expect(parsed?.createdAt).toBe(1000);
    expect(parsed?.updatedAt).toBe(2000);
  });

  it("keeps a huge tool result verbatim — truncation is a wire concern only", () => {
    const text = "x".repeat(60_000);
    const convo = newConversation("c1", 0);
    appendEntry(convo, { kind: "toolResult", callId: "t1", ok: true, text }, 0);

    const parsed = parseConversation(roundTrip(convo));
    expect(parsed?.entries[0]).toEqual({ kind: "toolResult", callId: "t1", ok: true, text });
  });

  it("rejects a blob from another version, or one that is not a conversation", () => {
    const convo = roundTrip(newConversation("c1", 0)) as Record<string, unknown>;
    expect(parseConversation({ ...convo, version: CHAT_STORE_VERSION + 1 })).toBeUndefined();
    expect(parseConversation({ ...convo, version: undefined })).toBeUndefined();
    expect(parseConversation({ ...convo, id: "" })).toBeUndefined();
    expect(parseConversation("nonsense")).toBeUndefined();
    expect(parseConversation([])).toBeUndefined();
    expect(parseConversation(undefined)).toBeUndefined();
  });

  it("repairs a damaged entry list rather than losing the conversation", () => {
    const parsed = parseConversation({
      version: CHAT_STORE_VERSION,
      id: "c1",
      title: "kept",
      createdAt: 1,
      updatedAt: 2,
      entries: [
        { kind: "user", text: "first" },
        null,
        "not an entry",
        { kind: "telepathy", text: "from the future" },
        { kind: "toolResult", callId: "t1", ok: true, text: 42 },
        { kind: "toolCall", callId: "t1", server: "cad", tool: "load", argsJson: "{}" },
        { kind: "assistant", text: "last" },
      ],
    });
    expect(parsed?.entries).toEqual([
      { kind: "user", text: "first" },
      { kind: "toolCall", callId: "t1", server: "cad", tool: "load", argsJson: "{}" },
      { kind: "assistant", text: "last" },
    ]);
    expect(parsed?.title).toBe("kept");
  });

  it("falls back for a missing title, timestamps and entry list", () => {
    const parsed = parseConversation({ version: CHAT_STORE_VERSION, id: "c1", createdAt: 7 });
    expect(parsed).toEqual({
      version: CHAT_STORE_VERSION,
      id: "c1",
      title: DEFAULT_TITLE,
      createdAt: 7,
      updatedAt: 7,
      entries: [],
    });
  });

  it("normalizes an unknown error kind rather than dropping the entry", () => {
    const parsed = parseConversation({
      version: CHAT_STORE_VERSION,
      id: "c1",
      createdAt: 0,
      entries: [{ kind: "error", message: "hm", errorKind: "wat" }],
    });
    expect(parsed?.entries).toEqual([{ kind: "error", message: "hm", errorKind: "other" }]);
  });

  it("caps a runaway entry list at read time too", () => {
    const entries = Array.from({ length: CONVERSATION_ENTRY_CAP + 5 }, (_, i) => ({ kind: "user", text: `m${i}` }));
    const parsed = parseConversation({ version: CHAT_STORE_VERSION, id: "c1", createdAt: 0, entries });
    expect(parsed?.entries).toHaveLength(CONVERSATION_ENTRY_CAP);
    expect(parsed?.entries[0]).toEqual({ kind: "user", text: "m5" });
  });
});

describe("parseIndex", () => {
  it("reads an index back, newest-updated first", () => {
    const parsed = parseIndex(roundTrip(index([meta("a", 10), meta("b", 30), meta("c", 20)], "c")));
    expect(parsed.conversations.map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(parsed.activeId).toBe("c");
  });

  it("reads garbage, an array and another version as no history", () => {
    const empty = { version: CHAT_STORE_VERSION, conversations: [], activeId: null };
    expect(parseIndex(undefined)).toEqual(empty);
    expect(parseIndex("nope")).toEqual(empty);
    expect(parseIndex([])).toEqual(empty);
    expect(parseIndex({ version: CHAT_STORE_VERSION + 1, conversations: [meta("a", 1)] })).toEqual(empty);
  });

  it("drops damaged and duplicate rows and defaults a missing entryCount", () => {
    const parsed = parseIndex({
      version: CHAT_STORE_VERSION,
      conversations: [{ id: "a", createdAt: 1 }, null, { title: "no id" }, meta("a", 5)],
      activeId: "a",
    });
    expect(parsed.conversations).toEqual([{ id: "a", title: DEFAULT_TITLE, createdAt: 1, updatedAt: 1, entryCount: 0 }]);
  });

  it("nulls an activeId that names no listed conversation", () => {
    expect(parseIndex(index([meta("a", 1)], "gone")).activeId).toBeNull();
  });
});

describe("pruneIndex", () => {
  it("drops rows whose file is gone and forgets an active one among them", () => {
    const pruned = pruneIndex(index([meta("a", 3), meta("b", 2)], "b"), (id) => id === "a");
    expect(pruned.conversations.map((c) => c.id)).toEqual(["a"]);
    expect(pruned.activeId).toBeNull();
  });

  it("leaves an intact index alone", () => {
    const before = index([meta("a", 3), meta("b", 2)], "a");
    expect(pruneIndex(before, () => true)).toEqual(before);
  });
});

describe("upsertMeta", () => {
  it("replaces a row in place and re-sorts by recency", () => {
    const after = upsertMeta(index([meta("a", 10), meta("b", 5)]), { ...meta("b", 20), title: "renamed" });
    expect(after.conversations.map((c) => c.id)).toEqual(["b", "a"]);
    expect(after.conversations[0].title).toBe("renamed");
    expect(after.conversations).toHaveLength(2);
  });
});

describe("capConversations", () => {
  it("keeps the most-recently-updated and reports what it evicted", () => {
    const rows = newestFirst(MAX_CONVERSATIONS + 3);
    const { index: capped, evicted } = capConversations(index(rows), MAX_CONVERSATIONS);
    expect(capped.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(evicted).toEqual(["c2", "c1", "c0"]);
  });

  it("never evicts the conversation the user is looking at", () => {
    const rows = newestFirst(MAX_CONVERSATIONS + 1);
    const { index: capped, evicted } = capConversations(index(rows, "c0"), MAX_CONVERSATIONS);
    expect(capped.conversations.map((c) => c.id)).toContain("c0");
    expect(evicted).toEqual(["c1"]);
  });

  it("is a no-op below the cap", () => {
    const before = index([meta("a", 1)]);
    expect(capConversations(before, MAX_CONVERSATIONS)).toEqual({ index: before, evicted: [] });
  });
});

describe("capEntries", () => {
  const entries = (n: number): ChatEntry[] => Array.from({ length: n }, (_, i) => ({ kind: "user", text: `m${i}` }));

  it("is a no-op below the cap", () => {
    const before = entries(3);
    expect(capEntries(before, 5)).toBe(before);
  });

  it("drops the oldest above the cap", () => {
    expect(capEntries(entries(5), 2)).toEqual([{ kind: "user", text: "m3" }, { kind: "user", text: "m4" }]);
  });
});

describe("deriveTitle", () => {
  it("uses the first non-empty line only", () => {
    expect(deriveTitle("\n\n  remesh the bracket \nand then export it")).toBe("remesh the bracket");
  });

  it("collapses whitespace runs", () => {
    expect(deriveTitle("open    the\tSTEP file")).toBe("open the STEP file");
  });

  it("ellipsises past the cap", () => {
    const title = deriveTitle("y".repeat(TITLE_CHARS + 20));
    expect(title).toBe(`${"y".repeat(TITLE_CHARS)}…`);
  });

  it("falls back for whitespace-only text", () => {
    expect(deriveTitle("   \n\t ")).toBe(DEFAULT_TITLE);
  });
});

describe("appendEntry", () => {
  it("titles the conversation from the first user message only", () => {
    const convo = newConversation("c1", 0);
    expect(isEmptyConversation(convo)).toBe(true);

    appendEntry(convo, { kind: "user", text: "mesh the bracket" }, 10);
    expect(convo.title).toBe("mesh the bracket");
    expect(convo.updatedAt).toBe(10);

    appendEntry(convo, { kind: "assistant", text: "done" }, 20);
    appendEntry(convo, { kind: "user", text: "now export it" }, 30);
    expect(convo.title).toBe("mesh the bracket");
    expect(convo.updatedAt).toBe(30);
    expect(isEmptyConversation(convo)).toBe(false);
    expect(metaFor(convo)).toEqual({ id: "c1", title: "mesh the bracket", createdAt: 0, updatedAt: 30, entryCount: 3 });
  });

  it("caps a runaway conversation as it grows", () => {
    const convo = newConversation("c1", 0);
    for (let i = 0; i < CONVERSATION_ENTRY_CAP + 10; i++) appendEntry(convo, { kind: "user", text: `m${i}` }, i);
    expect(convo.entries).toHaveLength(CONVERSATION_ENTRY_CAP);
    expect(convo.entries[0]).toEqual({ kind: "user", text: "m10" });
  });
});

describe("markStopped", () => {
  it("appends the partial text rather than retro-flagging a finished turn", () => {
    const convo = newConversation("c1", 0);
    appendEntry(convo, { kind: "user", text: "go" }, 1);
    appendEntry(convo, { kind: "assistant", text: "first turn, finished" }, 2);

    markStopped(convo, "second turn, interr", 3);

    expect(convo.entries[1]).toEqual({ kind: "assistant", text: "first turn, finished" });
    expect(convo.entries[2]).toEqual({ kind: "assistant", text: "second turn, interr", stopped: true });
    expect(convo.updatedAt).toBe(3);
  });
});
