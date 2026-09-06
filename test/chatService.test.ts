/**
 * ChatService — conversation ownership across an async turn.
 *
 * The agent loop appends to the transcript across many awaits, including in its
 * catch and finally. Once the user can switch or delete conversations mid-turn,
 * "which conversation does this belong to?" stops being obvious, and getting it
 * wrong files the model's tool calls under whatever document the user happened
 * to open next. Everything here pins that binding, plus the persistence the
 * feature exists for: a conversation survives a quit, and New archives rather
 * than destroys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebContents } from "electron";
import type { ChatToWebview } from "../app/main/ipc";

vi.mock("electron", async () => {
  const { electronStub } = await import("./stubs/electron");
  return { app: electronStub.app, ipcMain: electronStub.ipcMain, safeStorage: electronStub.safeStorage };
});

vi.mock("../app/main/services/stateStore", () => ({
  stateStore: {
    get: <T,>(_key: string, defaultValue?: T) => defaultValue,
    update: async () => undefined,
    flush: async () => undefined,
    flushSync: () => undefined,
  },
}));

const { ChatService } = await import("../app/main/services/chat/chatService");
const { TranscriptStore } = await import("../app/main/services/chat/transcriptStore");
const { PREVIEW_CHARS } = await import("../app/main/services/chat/transcript");
const { electronStub, fakeWebContents } = await import("./stubs/electron");
type Service = InstanceType<typeof ChatService>;

// ---- doubles ---------------------------------------------------------------

interface PendingTurn {
  onTextDelta(delta: string): void;
  resolve(result: { text: string; toolCalls: Array<{ id: string; name: string; argsJson: string }> }): void;
}

/** A provider whose turn is resolved by the test, and which rejects on abort
 *  the way the real ones do. */
class FakeProvider {
  private pending: PendingTurn | null = null;
  turns = 0;
  /** The entries the last turn was actually sent — where the context suffix
   *  lands, since it rides the newest user message and not the system prompt. */
  lastEntries: any[] = [];

  streamTurn = (options: any): Promise<any> => {
    this.turns++;
    this.lastEntries = options.entries ?? [];
    return new Promise((resolve, reject) => {
      this.pending = { onTextDelta: options.onTextDelta, resolve };
      options.signal.addEventListener("abort", () => reject(new Error("aborted by the user")));
    });
  };

  get waiting(): boolean {
    return !!this.pending;
  }
  emit(delta: string): void {
    this.pending!.onTextDelta(delta);
  }
  /** Finishes the turn, optionally asking for one tool call. */
  finish(text: string, tool?: { id: string; name: string; argsJson: string }): void {
    const pending = this.pending!;
    this.pending = null;
    pending.resolve({ text, toolCalls: tool ? [tool] : [] });
  }
}

class FakeMcp {
  private pending: ((outcome: { ok: boolean; text: string }) => void) | null = null;
  calls: string[] = [];

  chatTools = () => [];
  toolName = (server: string, tool: string) => `${server}__${tool}`;
  callTool = (name: string) => {
    this.calls.push(name);
    return new Promise<{ ok: boolean; text: string }>((resolve) => {
      this.pending = resolve;
    });
  };
  get waiting(): boolean {
    return !!this.pending;
  }
  finish(text = "tool output", ok = true): void {
    const pending = this.pending!;
    this.pending = null;
    pending({ ok, text });
  }
}

// ---- harness ---------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-chat-"));
});

afterEach(async () => {
  await settle();
  electronStub.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = async (ticks = 12) => {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

function makeService(currentFiles?: () => any) {
  const provider = new FakeProvider();
  const mcp = new FakeMcp();
  const { contents, messages } = fakeWebContents<ChatToWebview>();
  const hub = {
    ensureStarted: () => mcp,
    manager: () => mcp,
    statuses: () => [],
    onStatus: () => undefined,
    offStatus: () => undefined,
    dispose: () => undefined,
  };
  const service: Service = new ChatService({
    hub: hub as never,
    chatsDir: dir,
    currentFiles: currentFiles ?? (() => ({ cad: [], mesh: [] })),
    openSettings: () => undefined,
    onHide: () => undefined,
    provider: () => provider as never,
  });
  service.attach(contents as unknown as WebContents);
  const post = (payload: unknown) => electronStub.post("chat:toHost", contents, payload);
  return { service, provider, mcp, messages, post };
}

const lastState = (messages: ChatToWebview[]) =>
  [...messages].reverse().find((m): m is Extract<ChatToWebview, { type: "state" }> => m.type === "state")!;

const stored = (id: string) => new TranscriptStore(dir).load(id);
const listed = () => new TranscriptStore(dir).list().conversations;

/** Sends a message and lets the loop reach the provider. */
async function send(post: (p: unknown) => void, text: string) {
  post({ type: "send", text });
  await settle(4);
}

// ---- cases -----------------------------------------------------------------

describe("ChatService conversations", () => {
  it("persists a finished turn and replays it in a new process", async () => {
    const first = makeService();
    first.post({ type: "chatReady" });
    await send(first.post, "mesh the bracket");
    first.provider.finish("meshed it");
    await settle();
    first.service.flushSync();

    const id = lastState(first.messages).conversationId;
    expect(stored(id)?.entries).toEqual([
      { kind: "user", text: "mesh the bracket" },
      { kind: "assistant", text: "meshed it" },
    ]);

    // A second service over the same directory is the relaunch.
    const second = makeService();
    second.post({ type: "chatReady" });
    const state = lastState(second.messages);
    expect(state.conversationId).toBe(id);
    expect(state.conversationTitle).toBe("mesh the bracket");
    expect(state.entries).toEqual([
      { kind: "user", text: "mesh the bracket" },
      { kind: "assistant", text: "meshed it" },
    ]);
    expect(state.conversations.map((c) => c.id)).toEqual([id]);
  });

  it("stores a tool result in full while the renderer only sees a preview", async () => {
    const { post, provider, mcp, messages, service } = makeService();
    const big = "q".repeat(PREVIEW_CHARS + 3_000);
    post({ type: "chatReady" });
    await send(post, "inspect it");
    provider.finish("checking", { id: "t1", name: "mesh__mesh_info", argsJson: '{"path":"/a.mdpa"}' });
    await settle(4);
    mcp.finish(big);
    await settle(4);
    provider.finish("all good");
    await settle();
    service.flushSync();

    const id = lastState(messages).conversationId;
    const entries = stored(id)!.entries;
    expect(entries[2]).toEqual({ kind: "toolCall", callId: "t1", server: "mesh", tool: "mesh_info", argsJson: '{"path":"/a.mdpa"}' });
    expect(entries[3]).toEqual({ kind: "toolResult", callId: "t1", ok: true, text: big });

    const wire = messages.find((m) => m.type === "entry" && m.entry.kind === "toolResult");
    expect(wire && wire.type === "entry" && wire.entry.kind === "toolResult" && wire.entry.preview.length).toBeLessThan(big.length);
  });

  it("New archives the current conversation instead of destroying it", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "first conversation");
    provider.finish("done");
    await settle();
    const firstId = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settle();
    const state = lastState(messages);
    expect(state.conversationId).not.toBe(firstId);
    expect(state.entries).toEqual([]);
    service.flushSync();

    // The old one is still on disk, still listed, still complete.
    expect(stored(firstId)?.entries).toHaveLength(2);
    expect(listed().map((c) => c.id)).toEqual([firstId]);
  });

  it("New on an untouched conversation does not stack up empties", async () => {
    const { post, messages } = makeService();
    post({ type: "chatReady" });
    const before = lastState(messages).conversationId;
    post({ type: "newChat" });
    await settle();
    expect(lastState(messages).conversationId).toBe(before);
    expect(listed()).toEqual([]);
  });

  it("titles a conversation from its first user message", async () => {
    const { post, provider, messages } = makeService();
    post({ type: "chatReady" });
    await send(post, "remesh the bracket\nand export it");
    const named = messages.find((m) => m.type === "conversations");
    expect(named && named.type === "conversations" && named.conversations[0].title).toBe("remesh the bracket");
    provider.finish("ok");
    await settle();
  });

  it("switching mid-turn aborts it and records the partial text in the conversation it started in", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "long job");
    provider.emit("working on ");
    provider.emit("it");
    const firstId = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settle();
    service.flushSync();

    const state = lastState(messages);
    expect(state.conversationId).not.toBe(firstId);
    expect(state.entries).toEqual([]); // the new conversation, not the interrupted one
    expect(state.busy).toBe(false);

    expect(stored(firstId)?.entries).toEqual([
      { kind: "user", text: "long job" },
      { kind: "assistant", text: "working on it", stopped: true },
    ]);
  });

  it("nothing from the aborted turn paints after the switch", async () => {
    const { post, provider, messages } = makeService();
    post({ type: "chatReady" });
    await send(post, "long job");
    provider.emit("half a thought");

    post({ type: "newChat" });
    await settle();

    const stateIndex = messages.lastIndexOf(lastState(messages));
    const after = messages.slice(stateIndex + 1);
    expect(after.filter((m) => m.type === "entry" || m.type === "assistantDone" || m.type === "assistantDelta")).toEqual([]);
  });

  it("does not retro-flag a finished turn when the abort lands on a later one", async () => {
    const { post, provider, mcp, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "two turns");
    provider.finish("first turn, complete", { id: "t1", name: "cad__inspect", argsJson: "{}" });
    await settle(4);
    mcp.finish("inspected");
    await settle(4);
    expect(provider.waiting).toBe(true); // iteration 2 is under way
    provider.emit("second turn, interr");

    post({ type: "stop" });
    await settle();
    service.flushSync();

    const entries = stored(lastState(messages).conversationId)!.entries;
    expect(entries[1]).toEqual({ kind: "assistant", text: "first turn, complete" });
    expect(entries[4]).toEqual({ kind: "assistant", text: "second turn, interr", stopped: true });
  });

  it("deleting the active conversation mid-turn aborts it and lands on a fresh one", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "doomed");
    provider.emit("half");
    const doomed = lastState(messages).conversationId;

    post({ type: "deleteConversation", id: doomed });
    await settle();
    service.flushSync();

    expect(fs.existsSync(path.join(dir, `${doomed}.json`))).toBe(false);
    expect(listed()).toEqual([]);
    const state = lastState(messages);
    expect(state.conversationId).not.toBe(doomed);
    expect(state.entries).toEqual([]);
    expect(state.busy).toBe(false);
  });

  it("deleting a background conversation leaves the running turn alone", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "old one");
    provider.finish("done");
    await settle();
    const oldId = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settle();
    await send(post, "current one");
    provider.emit("still going");
    const currentId = lastState(messages).conversationId;

    post({ type: "deleteConversation", id: oldId });
    await settle();

    // The turn survived the deletion and can still finish.
    expect(provider.waiting).toBe(true);
    provider.finish("finished after the delete");
    await settle();
    service.flushSync();

    expect(fs.existsSync(path.join(dir, `${oldId}.json`))).toBe(false);
    expect(stored(currentId)?.entries).toEqual([
      { kind: "user", text: "current one" },
      { kind: "assistant", text: "finished after the delete" },
    ]);
  });

  it("selects a stored conversation and replays exactly its transcript", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "alpha");
    provider.finish("answer to alpha");
    await settle();
    const alpha = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settle();
    await send(post, "beta");
    provider.finish("answer to beta");
    await settle();
    const beta = lastState(messages).conversationId;

    post({ type: "selectConversation", id: alpha });
    await settle();
    expect(lastState(messages).entries).toEqual([
      { kind: "user", text: "alpha" },
      { kind: "assistant", text: "answer to alpha" },
    ]);

    post({ type: "selectConversation", id: beta });
    await settle();
    expect(lastState(messages).conversationTitle).toBe("beta");
    service.flushSync();
  });

  it("renames a conversation in the index and in the header", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "original");
    provider.finish("ok");
    await settle();
    const id = lastState(messages).conversationId;

    post({ type: "renameConversation", id, title: "  bracket   study  " });
    await settle();
    service.flushSync();

    expect(lastState(messages).conversationTitle).toBe("bracket study");
    expect(listed()[0].title).toBe("bracket study");
    expect(stored(id)?.title).toBe("bracket study");
  });

  it("flushSync during a turn records the interruption and lands it synchronously", async () => {
    const { post, provider, messages, service } = makeService();
    post({ type: "chatReady" });
    await send(post, "quitting mid-turn");
    provider.emit("partial answer");
    const id = lastState(messages).conversationId;

    service.flushSync(); // will-quit cannot await

    expect(stored(id)?.entries).toEqual([
      { kind: "user", text: "quitting mid-turn" },
      { kind: "assistant", text: "partial answer", stopped: true },
    ]);
    post({ type: "stop" });
    await settle();
  });
});

describe("workspace context suffix", () => {
  /** The suffix rides the newest user entry; the system prompt must stay
   *  byte-stable for prompt caching, so nothing here may reach it. */
  const suffixOf = (provider: { lastEntries: any[] }): string => {
    const last = [...provider.lastEntries].reverse().find((e) => e.kind === "user");
    return String(last?.text ?? "");
  };

  it("lists open tabs and marks the focused one", async () => {
    const { provider, post } = makeService(() => ({
      cad: ["/tmp/bull.stp", "/tmp/other.stp"],
      mesh: [],
      activeCad: "/tmp/bull.stp",
      projectRoot: "/tmp/project",
    }));
    post({ type: "send", text: "hello" });
    await settle();
    const text = suffixOf(provider);
    expect(text).toContain("Project root: /tmp/project");
    expect(text).toContain("/tmp/bull.stp (focused)");
    expect(text).toContain("/tmp/other.stp");
  });

  it("marks a cloud-backed path and warns that it is not stable", async () => {
    const staged = "/home/u/.config/kkss/cloud-cache/dropbox/ab/bull.stp";
    const { provider, post } = makeService(() => ({
      cad: [staged],
      mesh: [],
      activeCad: staged,
      cloud: { [staged]: { provider: "Dropbox", name: "bull.stp", folder: "/KKSS" } },
    }));
    post({ type: "send", text: "hello" });
    await settle();
    const text = suffixOf(provider);
    expect(text).toContain("(focused, Dropbox staging copy)");
    expect(text).toContain("not stable across sessions");
  });

  it("says nothing about staging when no document is cloud-backed", async () => {
    const { provider, post } = makeService(() => ({ cad: ["/tmp/bull.stp"], mesh: [], cloud: {} }));
    post({ type: "send", text: "hello" });
    await settle();
    const text = suffixOf(provider);
    expect(text).toContain("/tmp/bull.stp");
    expect(text).not.toContain("staging copy");
  });
});
