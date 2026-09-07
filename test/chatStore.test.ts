/**
 * TranscriptStore — the on-disk half of chat persistence. The cases that matter
 * are the ones a naive "write a JSON file" version gets wrong: a queued write
 * resurrecting a conversation the user just deleted, an index row outliving its
 * file, a corrupt blob taking the whole history down with it — and the property
 * the store exists to protect, that a stored tool result keeps its full text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptStore } from "../app/main/services/chat/transcriptStore";
import {
  appendEntry,
  CHAT_STORE_VERSION,
  CONVERSATION_KEY,
  MAX_CONVERSATIONS,
  type LiveConversation,
} from "../app/main/services/chat/transcriptStoreCore";
import { PREVIEW_CHARS, toWire } from "../app/main/services/chat/transcript";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-chats-"));
});

afterEach(async () => {
  // Let queued writes land before the directory goes, or they fail with ENOENT.
  await settle();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Backstop for teardown; individual cases await store.flush() instead, which
 *  is deterministic under load. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const files = () => fs.readdirSync(dir).sort();

/** A monotonic stand-in for Date.now(): conversations created inside one tick
 *  would otherwise share a timestamp, leaving "least recently updated"
 *  ambiguous — a non-issue at human pace, a coin flip in a loop. */
let clock = 1_700_000_000_000;
const tick = () => (clock += 1_000);

const say = (store: TranscriptStore, convo: LiveConversation, text: string) => {
  appendEntry(convo, { kind: "user", text }, tick());
  store.save(convo);
  return convo;
};

const started = (store: TranscriptStore, text: string) => say(store, store.create(), text);

describe("TranscriptStore", () => {
  it("writes a conversation and its index row, and a fresh store lists them", async () => {
    const store = new TranscriptStore(dir);
    const convo = started(store, "mesh the bracket");
    await store.flush();

    expect(files()).toEqual([`${convo.id}.json`, "index.json"].sort());

    const reopened = new TranscriptStore(dir);
    const index = reopened.list();
    expect(index.conversations).toHaveLength(1);
    expect(index.conversations[0]).toMatchObject({ id: convo.id, title: "mesh the bracket", entryCount: 1 });
    expect(index.activeId).toBe(convo.id);
    expect(reopened.load(convo.id)?.entries).toEqual([{ kind: "user", text: "mesh the bracket" }]);
  });

  it("never writes or lists a conversation with nothing in it", async () => {
    const store = new TranscriptStore(dir);
    const convo = store.create();
    store.save(convo);
    store.saveSoon(convo);
    await store.flush();

    expect(files()).toEqual([]);
    expect(store.list().conversations).toEqual([]);
  });

  it("stores a tool result in full, while the wire form still truncates it", async () => {
    const store = new TranscriptStore(dir);
    const text = "z".repeat(PREVIEW_CHARS + 5_000);
    const convo = store.create();
    appendEntry(convo, { kind: "user", text: "go" }, 1);
    appendEntry(convo, { kind: "toolResult", callId: "t1", ok: true, text }, 2);
    store.save(convo);
    await store.flush();

    const stored = new TranscriptStore(dir).load(convo.id)!;
    expect(stored.entries[1]).toEqual({ kind: "toolResult", callId: "t1", ok: true, text });
    const wire = toWire(stored.entries[1]);
    expect(wire.kind === "toolResult" && wire.preview.length).toBeLessThan(text.length);
  });

  it("restores the last active conversation, then the most recent one", async () => {
    const store = new TranscriptStore(dir);
    const first = started(store, "first");
    const second = started(store, "second");
    await store.flush();

    expect(new TranscriptStore(dir).restoreActive()?.id).toBe(second.id);

    store.setActive(first.id);
    await store.flush();
    expect(new TranscriptStore(dir).restoreActive()?.id).toBe(first.id);

    store.remove(first.id);
    await store.flush();
    expect(new TranscriptStore(dir).restoreActive()?.id).toBe(second.id);
  });

  it("prunes a row whose file vanished behind the app's back, and persists the pruning", async () => {
    const store = new TranscriptStore(dir);
    const kept = started(store, "kept");
    const gone = started(store, "gone");
    await store.flush();

    fs.rmSync(path.join(dir, `${gone.id}.json`));
    const reopened = new TranscriptStore(dir);
    expect(reopened.list().conversations.map((c) => c.id)).toEqual([kept.id]);
    await reopened.flush();

    // The pruned index is on disk, not just in memory.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Record<string, any>;
    expect(raw.index.conversations.map((c: { id: string }) => c.id)).toEqual([kept.id]);
    expect(raw.index.activeId).toBeNull();
  });

  it("reads a corrupt or foreign-version conversation as no such conversation", async () => {
    const store = new TranscriptStore(dir);
    const bad = started(store, "doomed");
    const good = started(store, "fine");
    await store.flush();

    fs.writeFileSync(
      path.join(dir, `${bad.id}.json`),
      JSON.stringify({ [CONVERSATION_KEY]: { version: CHAT_STORE_VERSION + 1, id: bad.id, entries: [] } })
    );

    const reopened = new TranscriptStore(dir);
    expect(reopened.load(bad.id)).toBeUndefined();
    expect(reopened.list().conversations.map((c) => c.id)).toEqual([good.id]);
    // Nothing is deleted just because it could not be understood.
    expect(fs.existsSync(path.join(dir, `${bad.id}.json`))).toBe(true);
  });

  it("survives an index.json that is not an index at all", async () => {
    fs.writeFileSync(path.join(dir, "index.json"), "{ not json");
    const store = new TranscriptStore(dir);
    expect(store.list().conversations).toEqual([]);
    expect(store.restoreActive()).toBeUndefined();

    const convo = started(store, "after the damage");
    await store.flush();
    expect(new TranscriptStore(dir).list().conversations.map((c) => c.id)).toEqual([convo.id]);
  });

  it("removes a conversation, and a queued write cannot resurrect it", async () => {
    const store = new TranscriptStore(dir);
    const convo = started(store, "delete me");
    await store.flush();

    say(store, convo, "one more"); // fire-and-forget write, still queued
    store.remove(convo.id);
    await store.flush();
    await settle();

    expect(fs.existsSync(path.join(dir, `${convo.id}.json`))).toBe(false);
    expect(store.list().conversations).toEqual([]);
    expect(store.list().activeId).toBeNull();
  });

  it("removing an unknown id is a no-op", async () => {
    const store = new TranscriptStore(dir);
    const convo = started(store, "kept");
    store.remove("00000000-0000-0000-0000-000000000000");
    await store.flush();
    expect(store.list().conversations.map((c) => c.id)).toEqual([convo.id]);
  });

  it("renames a conversation that is not open, in both the index and the file", async () => {
    const store = new TranscriptStore(dir);
    const convo = started(store, "original title");
    await store.flush();

    const reopened = new TranscriptStore(dir);
    reopened.rename(convo.id, "renamed");
    await reopened.flush();

    const third = new TranscriptStore(dir);
    expect(third.list().conversations[0].title).toBe("renamed");
    expect(third.load(convo.id)?.title).toBe("renamed");
  });

  it("caps the store at the limit, evicting the least recently updated", async () => {
    const store = new TranscriptStore(dir);
    const first = started(store, "first of many");
    for (let i = 0; i < MAX_CONVERSATIONS + 2; i++) started(store, `c${i}`);
    await store.flush();

    const index = new TranscriptStore(dir).list();
    expect(index.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(index.conversations.map((c) => c.id)).not.toContain(first.id);
    expect(files()).toHaveLength(MAX_CONVERSATIONS + 1); // + index.json
  });

  it("never evicts the conversation the user is looking at, however old it is", async () => {
    const store = new TranscriptStore(dir);
    for (let i = 0; i < MAX_CONVERSATIONS; i++) started(store, `c${i}`);
    // The least recently updated survivor — first in line to be evicted.
    const rows = store.list().conversations;
    const oldest = rows[rows.length - 1].id;
    store.setActive(oldest);

    started(store, "one more"); // create() is where the cap bites
    await store.flush();

    const index = new TranscriptStore(dir).list();
    expect(index.conversations).toHaveLength(MAX_CONVERSATIONS);
    expect(index.conversations.map((c) => c.id)).toContain(oldest);
  });

  it("saveSoon debounces, and flushSync lands what is pending", async () => {
    const store = new TranscriptStore(dir);
    const convo = store.create();
    appendEntry(convo, { kind: "user", text: "quitting now" }, tick());
    store.saveSoon(convo);
    expect(fs.existsSync(path.join(dir, `${convo.id}.json`))).toBe(false);

    store.save(convo);
    store.flushSync();

    expect(new TranscriptStore(dir).load(convo.id)?.entries).toEqual([{ kind: "user", text: "quitting now" }]);
    await settle();
  });

  it("closes a conversation without losing it, and leaves no temp files behind", async () => {
    const store = new TranscriptStore(dir);
    const convo = started(store, "closing");
    await store.close(convo);
    await store.flush();

    expect(files().filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(new TranscriptStore(dir).load(convo.id)?.entries).toHaveLength(1);
  });
});
