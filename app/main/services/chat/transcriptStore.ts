/**
 * Chat transcript persistence: the filesystem half of transcriptStoreCore.ts.
 *
 * Layout under <userData>/chats/ — one small `index.json` (the rows the sidebar
 * lists, plus which conversation was last active) and one `<id>.json` per
 * conversation. Deliberately not one growing blob: a tool result is capped at
 * RESULT_CHARS = 50 000 characters, so a single busy conversation is megabytes,
 * and listing the history must not mean parsing every one of them.
 *
 * Every file is a JsonStore (services/jsonStore.ts) holding a single key, which
 * buys the atomic temp-file + fsync + rename write, the single-writer chain
 * that coalesces the fire-and-forget saves the agent loop makes, and the
 * flushSync() the app needs on will-quit. Only the active conversation's store
 * is kept open — close() flushes and drops it, which is what makes the lazy
 * loading real rather than nominal.
 *
 * No `electron` import, so this is testable against a mkdtemp directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "../jsonStore";
import {
  CHAT_INDEX_KEY,
  CHAT_STORE_VERSION,
  CONVERSATION_KEY,
  MAX_CONVERSATIONS,
  capConversations,
  isEmptyConversation,
  metaFor,
  newConversation,
  parseConversation,
  parseIndex,
  pruneIndex,
  upsertMeta,
  type LiveConversation,
  type StoredIndex,
} from "./transcriptStoreCore";

/** Entries are appended one at a time during a turn; a write per append would
 *  re-serialize the whole transcript each time. Long enough to batch a burst of
 *  tool calls, short enough that a hard kill loses almost nothing. */
export const SAVE_DEBOUNCE_MS = 1_000;

export class TranscriptStore {
  private readonly indexStore: JsonStore;
  /** Open conversation stores, keyed by id — normally just the active one. */
  private readonly stores = new Map<string, JsonStore>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Conversations with a debounced save still pending, by id. */
  private readonly pending = new Map<string, LiveConversation>();
  /** Stores with a write queued or already made — the only ones flush() has
   *  anything to wait for. Flushing an untouched store would write it. */
  private readonly written = new Set<JsonStore>();

  constructor(private readonly dir: string) {
    this.indexStore = new JsonStore(path.join(dir, "index.json"));
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private storeFor(id: string): JsonStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new JsonStore(this.file(id));
      this.stores.set(id, store);
    }
    return store;
  }

  private readIndex(): StoredIndex {
    return parseIndex(this.indexStore.get(CHAT_INDEX_KEY));
  }

  private writeIndex(index: StoredIndex): void {
    this.persist(this.indexStore, (store) => store.update(CHAT_INDEX_KEY, index));
  }

  /** Every write here is fire-and-forget (the agent loop cannot wait on disk),
   *  so a rejection has to be caught: an unhandled one is fatal to the process
   *  in current Node, and losing a transcript must never take the app with it.
   *  JsonStore keeps the mutation dirty, so the next save retries it. */
  private persist(store: JsonStore, write: (store: JsonStore) => Promise<void>): void {
    this.written.add(store);
    void write(store).catch((err) => console.error("[chat] transcript write failed:", err));
  }

  /**
   * The listed conversations, newest-updated first. Rows whose file is gone are
   * pruned here and the pruned index persisted — the cheap alternative to a
   * transaction across two files, and the same read-time repair sessionCore
   * does for documents that vanished between quit and launch.
   */
  list(): StoredIndex {
    const index = this.readIndex();
    // An open store counts as existing: its first write may still be queued,
    // and pruning a conversation that is merely not-yet-on-disk would delete
    // the row the very save that created it is about to fill in.
    const pruned = pruneIndex(index, (id) => this.stores.has(id) || fs.existsSync(this.file(id)));
    if (pruned.conversations.length !== index.conversations.length || pruned.activeId !== index.activeId) {
      this.writeIndex(pruned);
    }
    return pruned;
  }

  /** The conversation to open on launch: the last active one, else the most
   *  recently updated one that still reads, else nothing. */
  restoreActive(): LiveConversation | undefined {
    const index = this.list();
    const ordered = index.activeId
      ? [index.activeId, ...index.conversations.map((c) => c.id).filter((id) => id !== index.activeId)]
      : index.conversations.map((c) => c.id);
    for (const id of ordered) {
      const convo = this.load(id);
      if (convo) return convo;
    }
    return undefined;
  }

  /**
   * Reads one conversation. A blob this build cannot interpret (corrupt, or
   * written by another CHAT_STORE_VERSION) drops out of the index but is left
   * on disk — nothing is deleted just because it could not be understood.
   */
  load(id: string): LiveConversation | undefined {
    const store = this.storeFor(id);
    const parsed = parseConversation(store.get(CONVERSATION_KEY));
    if (!parsed) {
      this.written.delete(store);
      this.stores.delete(id);
      this.dropRow(id);
      return undefined;
    }
    return { ...parsed, alive: true };
  }

  /**
   * A fresh conversation. It is neither written nor indexed until its first
   * entry, so **New** costs nothing and an untouched one never litters the
   * history list. Creating one is also when the store is capped.
   */
  create(): LiveConversation {
    // Cap to one below the limit: the conversation being created is about to
    // take a slot, so the store settles at exactly MAX_CONVERSATIONS.
    const { index, evicted } = capConversations(this.list(), MAX_CONVERSATIONS - 1);
    if (evicted.length) {
      for (const id of evicted) this.forget(id);
      this.writeIndex(index);
    }
    return newConversation(randomUUID(), Date.now());
  }

  /** Persists on the next quiet moment. No-op for a conversation with nothing
   *  in it yet. */
  saveSoon(convo: LiveConversation): void {
    if (!convo.alive || isEmptyConversation(convo)) return;
    if (this.timers.has(convo.id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(convo.id);
      this.save(convo);
    }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(convo.id, timer);
    this.pending.set(convo.id, convo);
  }

  /** Persists now (the JsonStore chain does the actual write asynchronously,
   *  coalescing with anything already queued). */
  save(convo: LiveConversation): void {
    this.cancel(convo.id);
    if (!convo.alive || isEmptyConversation(convo)) return;
    const { alive: _alive, ...stored } = convo;
    // A copy: the live conversation keeps mutating, and capEntries replaces the
    // array outright, so handing the store the live reference would let it
    // serialize something the caller no longer considers current.
    this.persist(this.storeFor(convo.id), (store) =>
      store.update(CONVERSATION_KEY, { ...stored, entries: [...convo.entries] })
    );
    const index = upsertMeta(this.list(), metaFor(convo));
    this.writeIndex({ ...index, activeId: convo.id });
  }

  /** Marks a listed conversation as the one to reopen on the next launch. */
  setActive(id: string): void {
    const index = this.list();
    if (index.activeId === id || !index.conversations.some((c) => c.id === id)) return;
    this.writeIndex({ ...index, activeId: id });
  }

  /** Renames a conversation. The file is only patched when it is not open —
   *  an open one is owned by the caller's live object, whose next save carries
   *  the new title (and would otherwise be overwritten by a stale blob). */
  rename(id: string, title: string): void {
    const index = this.list();
    const meta = index.conversations.find((c) => c.id === id);
    if (meta) this.writeIndex(upsertMeta(index, { ...meta, title }));
    if (this.stores.has(id)) return;
    const store = new JsonStore(this.file(id));
    const parsed = parseConversation(store.get(CONVERSATION_KEY));
    if (parsed) this.persist(store, (s) => s.update(CONVERSATION_KEY, { ...parsed, title }));
  }

  /** Deletes a conversation, file and row. */
  remove(id: string): void {
    this.forget(id);
    this.dropRow(id);
  }

  /** Flushes a conversation and drops it from memory. */
  async close(convo: LiveConversation): Promise<void> {
    this.save(convo);
    const store = this.stores.get(convo.id);
    this.stores.delete(convo.id);
    if (store) this.written.delete(store);
    await store?.flush().catch(() => undefined);
  }

  /** Resolves once every queued write is durable. */
  async flush(): Promise<void> {
    for (const id of [...this.timers.keys()]) {
      const convo = this.pending.get(id);
      this.cancel(id);
      if (convo) this.save(convo);
    }
    await Promise.all([...this.written].map((store) => store.flush().catch(() => undefined)));
  }

  /** Last-chance synchronous write for will-quit, which cannot await. */
  flushSync(): void {
    for (const id of [...this.timers.keys()]) {
      const convo = this.pending.get(id);
      this.cancel(id);
      if (convo) this.save(convo);
    }
    for (const store of this.stores.values()) store.flushSync();
    this.indexStore.flushSync();
  }

  private cancel(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.pending.delete(id);
  }

  /** Removes the file, neutering any queued write first: JsonStore.flushSync()
   *  latches its stopped flag permanently, so an in-flight save can no longer
   *  land — and so cannot recreate the file we are about to unlink. */
  private forget(id: string): void {
    this.cancel(id);
    const store = this.stores.get(id);
    if (store) {
      store.flushSync();
      this.stores.delete(id);
      this.written.delete(store);
    }
    try {
      fs.rmSync(this.file(id), { force: true });
    } catch {
      /* a conversation we cannot delete is not worth failing a click over */
    }
  }

  private dropRow(id: string): void {
    const index = this.list();
    if (!index.conversations.some((c) => c.id === id)) return;
    this.writeIndex({
      ...index,
      version: CHAT_STORE_VERSION,
      conversations: index.conversations.filter((c) => c.id !== id),
      activeId: index.activeId === id ? null : index.activeId,
    });
  }
}
