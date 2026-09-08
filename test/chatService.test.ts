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
import type { ChatImage, ChatToWebview } from "../app/main/ipc";
import type { StreamTurnOptions, ToolDef } from "../app/main/services/chat/providers/types";

vi.mock("electron", async () => {
  const { electronStub } = await import("./stubs/electron");
  return { app: electronStub.app, ipcMain: electronStub.ipcMain, safeStorage: electronStub.safeStorage };
});

/** Settings the service reads. Mutable so a case can flip the approval mode;
 *  reset in beforeEach, so an unset key still yields the real default. */
const stateValues: Record<string, unknown> = {};

vi.mock("../app/main/services/stateStore", () => ({
  stateStore: {
    get: <T,>(key: string, defaultValue?: T) =>
      key in stateValues ? (stateValues[key] as T) : defaultValue,
    update: async () => undefined,
    flush: async () => undefined,
    flushSync: () => undefined,
  },
}));

const { ChatService, evictImages } = await import("../app/main/services/chat/chatService");
const { CLEARED_PLACEHOLDER } = await import("../app/main/services/chat/compaction");
const { ProviderError } = await import("../app/main/services/chat/providers/types");
const { TranscriptStore } = await import("../app/main/services/chat/transcriptStore");
const { PREVIEW_CHARS } = await import("../app/main/services/chat/transcript");
const { electronStub, fakeWebContents } = await import("./stubs/electron");
type Service = InstanceType<typeof ChatService>;

// ---- doubles ---------------------------------------------------------------

interface PendingTurn {
  onTextDelta(delta: string): void;
  resolve(result: { text: string; toolCalls: Array<{ id: string; name: string; argsJson: string }> }): void;
  reject(error: unknown): void;
}

interface ToolReq {
  id: string;
  name: string;
  argsJson: string;
}

/** A provider whose turn is resolved by the test, and which rejects on abort
 *  the way the real ones do. */
type FakeUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

class FakeProvider {
  private pending: PendingTurn | null = null;
  turns = 0;
  /** The entries the last turn was actually sent — where the context suffix
   *  lands, since it rides the newest user message and not the system prompt. */
  lastEntries: any[] = [];
  requests: StreamTurnOptions[] = [];

  streamTurn = (options: any): Promise<any> => {
    this.turns++;
    this.requests.push(options);
    this.lastEntries = options.entries ?? [];
    return new Promise((resolve, reject) => {
      this.pending = { onTextDelta: options.onTextDelta, resolve, reject };
      options.signal.addEventListener("abort", () => reject(new Error("aborted by the user")));
    });
  };

  get waiting(): boolean {
    return !!this.pending;
  }
  emit(delta: string): void {
    this.pending!.onTextDelta(delta);
  }
  /** Fails the turn the way a provider would — the reactive-compaction seam. */
  fail(error: unknown): void {
    const pending = this.pending!;
    this.pending = null;
    pending.reject(error);
  }
  /** Finishes the turn, optionally asking for one tool call — or several, and
   *  optionally reporting usage the way a real provider would. */
  finish(text: string, tool?: ToolReq | ToolReq[], usage?: FakeUsage): void {
    const pending = this.pending!;
    this.pending = null;
    pending.resolve({ text, toolCalls: tool ? (Array.isArray(tool) ? tool : [tool]) : [], ...(usage ? { usage } : {}) });
  }
}

type FakeOutcome = { ok: boolean; text: string; images?: ChatImage[] };

/** Records arguments and holds several calls at once: a dry run runs while the
 *  approval it belongs to is still open, so a single pending slot could not
 *  express the case at all. */
class FakeMcp {
  private queue: Array<(outcome: FakeOutcome) => void> = [];
  requests: Array<{ name: string; argsJson: string }> = [];

  get calls(): string[] {
    return this.requests.map((request) => request.name);
  }
  availableTools: ToolDef[] = [];
  chatTools = () => [...this.availableTools];
  toolName = (server: string, tool: string) => `${server}__${tool}`;
  callTool = (name: string, argsJson: string) => {
    this.requests.push({ name, argsJson });
    return new Promise<FakeOutcome>((resolve) => {
      this.queue.push(resolve);
    });
  };
  get waiting(): boolean {
    return this.queue.length > 0;
  }
  get inFlight(): number {
    return this.queue.length;
  }
  /** Resolves the oldest outstanding call. */
  finish(text = "tool output", ok = true, images?: ChatImage[]): void {
    this.queue.shift()!({ ok, text, ...(images ? { images } : {}) });
  }
  /** Resolves one specific outstanding call, oldest-first indexed. */
  finishAt(index: number, text = "tool output", ok = true): void {
    const [resolve] = this.queue.splice(index, 1);
    resolve({ ok, text });
  }
}

// ---- harness ---------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-chat-"));
  for (const key of Object.keys(stateValues)) delete stateValues[key];
});

afterEach(async () => {
  await settle();
  electronStub.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Real timers, not fake ones: the service chains real promise turns (provider,
// MCP, disk flushes) rather than anything vitest's fake-timer clock advances.
// The default tick count is deliberately generous — a CI runner under
// contention can stall the process for tens of milliseconds between event
// loop turns, and each tick only needs to be *reached*, not fully used, so a
// bigger budget costs wall-clock, not CPU, when the work finishes early.
const settle = async (ticks = 40) => {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

/** switchTo() (newChat/selectConversation/deleteConversation) awaits a real
 *  flush (fsync + rename) of the outgoing conversation before it sends the new
 *  state — under CI disk contention that can outrun settle()'s fixed tick
 *  budget (this is the same race the "switching conversations while a prompt
 *  is open" case below already works around), so poll for the state actually
 *  changing rather than assuming a fixed number of ticks is always enough. */
async function settleAfterSwitch(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 4000, interval: 10 });
}

function makeService(currentFiles?: () => any) {
  const provider = new FakeProvider();
  const mcp = new FakeMcp();
  const { contents, messages } = fakeWebContents<ChatToWebview>();
  const hub = {
    ensureStarted: () => mcp,
    manager: () => mcp,
    retryKratos: vi.fn(async (_install?: boolean) => {}),
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
  return { service, provider, mcp, messages, post, hub };
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

describe("Kratos recovery IPC", () => {
  it("accepts only fixed recovery actions from the attached renderer", async () => {
    const { service, post, hub } = makeService();
    post(null);
    post({ type: "installKratosRuntime", command: "untrusted", url: "https://untrusted.invalid" });
    post({ type: "retryKratos" });
    post({ type: "runInstaller", command: "untrusted" });
    const stranger = fakeWebContents<ChatToWebview>().contents;
    electronStub.post("chat:toHost", stranger, { type: "installKratosRuntime" });
    expect(hub.retryKratos.mock.calls).toEqual([[true], []]);
    service.flushSync();
  });
});

describe("per-turn tool snapshot", () => {
  it("keeps tools and system stable through server startup and a context retry, refreshing next turn", async () => {
    const { service, provider, mcp, post } = makeService();
    const inspect: ToolDef = { name: "cad__inspect", inputSchema: { type: "object" } };
    const mesh: ToolDef = { name: "mesh__mesh_info", inputSchema: { type: "object" } };
    mcp.availableTools = [inspect];
    post({ type: "chatReady" });
    await send(post, "inspect the model");
    expect(provider.requests[0].tools).toEqual([inspect]);

    // Another server connects while the first provider request is in flight.
    mcp.availableTools.push(mesh);
    provider.finish("inspecting", { id: "t1", name: inspect.name, argsJson: "{}" });
    await settle(4);
    mcp.finish("inspection result");
    await settle(4);
    provider.fail(new ProviderError("context", "prompt too long"));
    await settle(6);
    expect(provider.requests).toHaveLength(3);
    for (const request of provider.requests) {
      expect(request.tools).toEqual([inspect]);
      expect(request.system).toBe(provider.requests[0].system);
    }
    provider.finish("done");
    await settle();

    await send(post, "inspect the mesh too");
    expect(provider.requests[3].tools).toEqual([inspect, mesh]);
    provider.finish("done again");
    await settle();
    service.flushSync();
  });

  it("starts immediately with no ready tools and discovers them on the next turn", async () => {
    const { service, provider, mcp, post } = makeService();
    await send(post, "hello");
    expect(provider.requests[0].tools).toEqual([]);
    mcp.availableTools = [{ name: "cad__inspect", inputSchema: { type: "object" } }];
    provider.finish("hello");
    await settle();
    await send(post, "inspect");
    expect(provider.requests[1].tools).toEqual(mcp.availableTools);
    provider.finish("done");
    await settle();
    service.flushSync();
  });
});

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
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(firstId));
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
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(firstId));
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
    const firstId = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(firstId));

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
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(doomed));
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
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(oldId));
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
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(alpha));
    await send(post, "beta");
    provider.finish("answer to beta");
    await settle();
    const beta = lastState(messages).conversationId;

    post({ type: "selectConversation", id: alpha });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).toBe(alpha));
    expect(lastState(messages).entries).toEqual([
      { kind: "user", text: "alpha" },
      { kind: "assistant", text: "answer to alpha" },
    ]);

    post({ type: "selectConversation", id: beta });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).toBe(beta));
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

describe("tool-call approval", () => {
  const READ = { id: "t1", name: "cad__inspect", argsJson: "{}" };
  const WRITE = { id: "t1", name: "mesh__mesh_transform", argsJson: '{"path":"/a.mdpa"}' };
  const UNKNOWN = { id: "t1", name: "kratos__run_simulation", argsJson: "{}" };

  const requests = (messages: ChatToWebview[]) =>
    messages.filter((m): m is Extract<ChatToWebview, { type: "approvalRequest" }> => m.type === "approvalRequest");

  /** Drives a turn to the point of the first tool call. `chatReady` first, so
   *  a `state` message exists for the conversation-id lookups below. */
  const upToTool = async (
    tool: ToolReq | ToolReq[],
    post: ReturnType<typeof makeService>["post"],
    provider: FakeProvider
  ) => {
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("working", tool);
    await settle(4);
  };

  it("runs a read-only tool without asking", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToTool(READ, post, provider);
    expect(requests(messages)).toHaveLength(0);
    expect(mcp.calls).toEqual(["cad__inspect"]);
  });

  it("asks before a write tool, and a denied call never reaches the MCP layer", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToTool(WRITE, post, provider);

    const asked = requests(messages);
    expect(asked).toHaveLength(1);
    expect(asked[0].pending).toMatchObject({ callId: "t1", server: "mesh", tool: "mesh_transform", access: "write" });
    // The arguments must reach the prompt — approving something you cannot read
    // is not approval.
    expect(asked[0].pending.argsJson).toBe('{"path":"/a.mdpa"}');
    expect(mcp.calls).toEqual([]);

    post({ type: "approveTool", callId: "t1", decision: "deny" });
    await settle();
    // The whole point: the tool never ran.
    expect(mcp.calls).toEqual([]);
  });

  it("reports a denial back to the model instead of dropping the call", async () => {
    const { service, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "approveTool", callId: "t1", decision: "deny" });
    await settle();
    // Entry writes are debounced; flushSync lands them, as the tool-result
    // case above already does.
    service.flushSync();

    const entries = stored(lastState(messages).conversationId)!.entries;
    const call = entries.find((e) => e.kind === "toolCall")!;
    const result = entries.find((e) => e.kind === "toolResult")!;
    expect(call).toMatchObject({ callId: "t1", approval: "denied" });
    // Without a result, transcript.ts drops the call and the model re-emits it.
    expect(result).toMatchObject({ callId: "t1", ok: false });
    expect((result as { text: string }).text).toMatch(/Denied by the user/);

    // ...and it is genuinely in the next request the provider receives.
    provider.finish("I'll explain instead.");
    await settle();
    expect(JSON.stringify(provider.lastEntries)).toContain("Denied by the user");
  });

  it("runs the tool when approved, and records the decision", async () => {
    const { service, mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "approveTool", callId: "t1", decision: "allow" });
    await settle();
    expect(mcp.calls).toEqual(["mesh__mesh_transform"]);
    mcp.finish("transformed");
    await settle();
    service.flushSync();
    const call = stored(lastState(messages).conversationId)!.entries.find((e) => e.kind === "toolCall");
    expect(call).toMatchObject({ approval: "allowed" });
  });

  it("always-allow suppresses the next prompt for that tool but not another", async () => {
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "approveTool", callId: "t1", decision: "allowAlways" });
    await settle();
    mcp.finish("done");
    await settle();

    // Same tool again: runs straight through.
    provider.finish("again", { ...WRITE, id: "t2" });
    await settle();
    expect(requests(messages)).toHaveLength(1);
    expect(mcp.calls).toEqual(["mesh__mesh_transform", "mesh__mesh_transform"]);
    mcp.finish("done");
    await settle();

    // A different write tool is still gated — the grant is per tool, not a
    // blanket "this conversation is trusted".
    provider.finish("now export", { id: "t3", name: "mesh__mesh_convert", argsJson: "{}" });
    await settle();
    expect(requests(messages)).toHaveLength(2);
    expect(mcp.calls).toHaveLength(2);
  });

  it("asks about a tool it has no policy for", async () => {
    // Every kratos tool, today: that server is resolved at runtime and is not
    // in this tree, so it cannot be honestly classified.
    const { provider, mcp, messages, post } = makeService();
    await upToTool(UNKNOWN, post, provider);
    expect(requests(messages)[0].pending.access).toBe("unknown");
    expect(mcp.calls).toEqual([]);
  });

  it("gates each call of a batch independently", async () => {
    const { mcp, provider, messages, post } = makeService();
    await upToTool([WRITE, { id: "t2", name: "cad__inspect", argsJson: "{}" }], post, provider);
    expect(requests(messages)).toHaveLength(1);
    post({ type: "approveTool", callId: "t1", decision: "deny" });
    await settle();
    // The denial does not poison the read-only call that followed it.
    expect(mcp.calls).toEqual(["cad__inspect"]);
  });

  it("Stop while a prompt is open unwinds the turn and leaves the service usable", async () => {
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "stop" });
    await settle();

    expect(mcp.calls).toEqual([]);
    expect(messages.filter((m) => m.type === "busy" && !m.busy)).not.toHaveLength(0);
    // Not wedged: a fresh turn still starts.
    post({ type: "send", text: "again" });
    await settle();
    expect(provider.waiting).toBe(true);
  });

  it("switching conversations while a prompt is open does not deadlock", async () => {
    // The canary. settleTurn() AWAITS the turn, so an approval promise that
    // never settles hangs this test (and the app's New/Select/Delete) rather
    // than failing it — hence the explicit timeout.
    const { provider, mcp, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    const before = lastState(messages).conversationId;
    post({ type: "newChat" });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(before));
    expect(mcp.calls).toEqual([]);
  }, 5000);

  it("deleting the active conversation while a prompt is open unwinds it", async () => {
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    const id = lastState(messages).conversationId;
    post({ type: "deleteConversation", id });
    await settle();
    expect(stored(id)).toBeUndefined();
    expect(mcp.calls).toEqual([]);
  }, 5000);

  it("flushSync while a prompt is open denies it and records the interruption", async () => {
    const { service, provider, mcp, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    service.flushSync();
    await settle();
    expect(mcp.calls).toEqual([]);
    const entries = stored(lastState(messages).conversationId)!.entries;
    expect(entries[entries.length - 1]).toMatchObject({ kind: "assistant", stopped: true });
  }, 5000);

  it("ignores a decision that arrives after the turn was aborted", async () => {
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "stop" });
    await settle();
    const seen = messages.length;
    post({ type: "approveTool", callId: "t1", decision: "allow" });
    await settle();
    expect(mcp.calls).toEqual([]);
    expect(messages).toHaveLength(seen);
  });

  it("ignores a decision for a call that is not the one waiting", async () => {
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "approveTool", callId: "some-other-call", decision: "allow" });
    await settle();
    // Still waiting on the real one.
    expect(mcp.calls).toEqual([]);
    post({ type: "approveTool", callId: "t1", decision: "allow" });
    await settle();
    expect(mcp.calls).toEqual(["mesh__mesh_transform"]);
  });

  it("replays a pending prompt on chatReady, so a reload resumes the turn", async () => {
    const { provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    post({ type: "chatReady" });
    await settle();
    expect(lastState(messages).pendingApproval).toMatchObject({ callId: "t1", tool: "mesh_transform" });
  });

  it("runs a write tool unprompted when approval is turned off", async () => {
    stateValues.llmToolApproval = "never";
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    expect(requests(messages)).toHaveLength(0);
    expect(mcp.calls).toEqual(["mesh__mesh_transform"]);
  });

  it("asks about a read-only tool in askAlways", async () => {
    stateValues.llmToolApproval = "askAlways";
    const { mcp, provider, messages, post } = makeService();
    await upToTool(READ, post, provider);
    expect(requests(messages)).toHaveLength(1);
    expect(mcp.calls).toEqual([]);
  });

  it("falls back to the default for a nonsense stored mode", async () => {
    stateValues.llmToolApproval = "off";
    const { mcp, provider, messages, post } = makeService();
    await upToTool(WRITE, post, provider);
    // Degrades to askOnWrite, never to "never".
    expect(requests(messages)).toHaveLength(1);
    expect(mcp.calls).toEqual([]);
  });
});

describe("tool-result images", () => {
  const SNAP = { id: "t1", name: "cad__render_snapshot", argsJson: "{}" };
  const IMAGES: ChatImage[] = [
    { mimeType: "image/png", dataBase64: "AAAA" },
    { mimeType: "image/png", dataBase64: "BBBB" },
  ];

  const imageMsgs = (messages: ChatToWebview[]) =>
    messages.filter((m): m is Extract<ChatToWebview, { type: "toolImages" }> => m.type === "toolImages");

  const upToResult = async (post: ReturnType<typeof makeService>["post"], provider: FakeProvider, mcp: FakeMcp) => {
    post({ type: "chatReady" });
    await send(post, "render it");
    provider.finish("looking", SNAP);
    await settle(4);
    mcp.finish("rendered", true, IMAGES);
    await settle(4);
  };

  it("paints a live result's images and expands the chip", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToResult(post, provider, mcp);
    const painted = imageMsgs(messages);
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ callId: "t1", live: true });
    expect(painted[0].images).toEqual(IMAGES);
  });

  it("keeps images out of the stored transcript entirely", async () => {
    const { service, provider, mcp, messages, post } = makeService();
    await upToResult(post, provider, mcp);
    provider.finish("done");
    await settle();
    service.flushSync();
    const entries = stored(lastState(messages).conversationId)!.entries;
    const result = entries.find((e) => e.kind === "toolResult")!;
    // The model was given the text, and only the text; the picture is UI.
    expect(result).toEqual({ kind: "toolResult", callId: "t1", ok: true, text: "rendered" });
  });

  it("replays images after a reload, collapsed rather than expanded", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToResult(post, provider, mcp);
    provider.finish("done");
    await settle();
    messages.length = 0;
    post({ type: "chatReady" });
    await settle();
    const replayed = imageMsgs(messages);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ callId: "t1", live: false });
    // After the transcript, so the chip it attaches to already exists.
    expect(messages.findIndex((m) => m.type === "state")).toBeLessThan(messages.indexOf(replayed[0]));
  });

  it("forgets them when the conversation changes", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToResult(post, provider, mcp);
    provider.finish("done");
    await settle();
    const before = lastState(messages).conversationId;
    post({ type: "newChat" });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(before));
    messages.length = 0;
    post({ type: "chatReady" });
    await settle();
    expect(imageMsgs(messages)).toHaveLength(0);
  });

  it("evicts oldest-first once the budget is exceeded", () => {
    const image = (bytes: number): ChatImage[] => [{ mimeType: "image/png", dataBase64: "A".repeat(bytes) }];
    const map = new Map([
      ["oldest", image(60)],
      ["middle", image(60)],
      ["newest", image(60)],
    ]);
    evictImages(map, 150);
    expect([...map.keys()]).toEqual(["middle", "newest"]);
  });

  it("leaves a map that is already within budget alone", () => {
    const map = new Map([["a", [{ mimeType: "image/png", dataBase64: "AAAA" }]]]);
    evictImages(map, 1000);
    expect([...map.keys()]).toEqual(["a"]);
  });
});

describe("dry-run validation", () => {
  const DRY = { id: "t1", name: "cad__apply_edit_ops", argsJson: '{"path":"/a.stp","ops":[]}' };
  const PLAIN = { id: "t1", name: "mesh__mesh_transform", argsJson: '{"path":"/a.mdpa"}' };

  const reports = (messages: ChatToWebview[]) =>
    messages.filter((m): m is Extract<ChatToWebview, { type: "dryRunResult" }> => m.type === "dryRunResult");

  const upToPrompt = async (
    tool: ToolReq,
    post: ReturnType<typeof makeService>["post"],
    provider: FakeProvider
  ) => {
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("working", tool);
    await settle(4);
  };

  const asked = (messages: ChatToWebview[]) =>
    messages.filter((m): m is Extract<ChatToWebview, { type: "approvalRequest" }> => m.type === "approvalRequest");

  it("offers validation only for a tool that declares the parameter", async () => {
    const dry = makeService();
    await upToPrompt(DRY, dry.post, dry.provider);
    expect(asked(dry.messages)[0].pending).toMatchObject({ dryRunnable: true });

    const plain = makeService();
    await upToPrompt(PLAIN, plain.post, plain.provider);
    expect(asked(plain.messages)[0].pending).toMatchObject({ dryRunnable: false });
  });

  it("runs the call with dryRun set, then still runs it unmodified on approval", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToPrompt(DRY, post, provider);

    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    expect(mcp.requests).toEqual([{ name: "cad__apply_edit_ops", argsJson: '{"path":"/a.stp","ops":[],"dryRun":true}' }]);
    mcp.finish("2 ops accepted");
    await settle();
    expect(reports(messages)).toMatchObject([{ callId: "t1", ok: true, text: "2 ops accepted" }]);

    // The gate is still open — validating is not deciding.
    post({ type: "chatReady" });
    await settle();
    expect(lastState(messages).pendingApproval).toMatchObject({ callId: "t1" });

    post({ type: "approveTool", callId: "t1", decision: "allow" });
    await settle();
    // The real call carries the arguments the user approved, not the rewrite.
    expect(mcp.requests[1]).toEqual({ name: "cad__apply_edit_ops", argsJson: '{"path":"/a.stp","ops":[]}' });
  });

  it("never lets the report reach the transcript or the model", async () => {
    const { service, provider, mcp, messages, post } = makeService();
    await upToPrompt(DRY, post, provider);
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    mcp.finish("would apply 2 ops");
    await settle();
    post({ type: "approveTool", callId: "t1", decision: "allow" });
    await settle();
    mcp.finish("applied");
    await settle();
    provider.finish("done");
    await settle();
    service.flushSync();

    const entries = stored(lastState(messages).conversationId)!.entries;
    const results = entries.filter((e) => e.kind === "toolResult");
    // Exactly one result for exactly one call: the model is never handed a
    // result for a call that did not happen.
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ text: "applied" });
    expect(JSON.stringify(entries)).not.toContain("would apply 2 ops");
  });

  it("replays a completed report with the prompt, so a reload keeps it", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToPrompt(DRY, post, provider);
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    mcp.finish("1 op rejected", false);
    await settle();
    post({ type: "chatReady" });
    await settle();
    expect(lastState(messages).pendingApproval).toMatchObject({
      callId: "t1",
      dryRunPreview: { ok: false, text: "1 op rejected" },
    });
  });

  it("drops a report that lands after the turn was stopped", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToPrompt(DRY, post, provider);
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    post({ type: "stop" });
    await settle();
    mcp.finish("too late");
    await settle();
    expect(reports(messages)).toHaveLength(0);
  });

  it("drops a report after the conversation it belonged to was deleted", async () => {
    const { provider, mcp, messages, post } = makeService();
    await upToPrompt(DRY, post, provider);
    const id = lastState(messages).conversationId;
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    post({ type: "deleteConversation", id });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(id));
    mcp.finish("too late");
    await settle();
    expect(reports(messages)).toHaveLength(0);
  });

  it("ignores a second request while one is already running", async () => {
    const { provider, mcp, post } = makeService();
    await upToPrompt(DRY, post, provider);
    post({ type: "dryRunTool", callId: "t1" });
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    expect(mcp.inFlight).toBe(1);
  });

  it("ignores a request for a call that is not the one waiting", async () => {
    const { provider, mcp, post } = makeService();
    await upToPrompt(DRY, post, provider);
    post({ type: "dryRunTool", callId: "some-other-call" });
    await settle();
    expect(mcp.calls).toEqual([]);
  });

  it("ignores a request for a tool that cannot be dry-run", async () => {
    const { provider, mcp, post } = makeService();
    await upToPrompt(PLAIN, post, provider);
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    expect(mcp.calls).toEqual([]);
  });

  it("stays closable with a validation still in flight", async () => {
    const { service, provider, mcp, messages, post } = makeService();
    await upToPrompt(DRY, post, provider);
    post({ type: "dryRunTool", callId: "t1" });
    await settle();
    // will-quit cannot await: the gate must already have been settled by the
    // time this returns, dry run outstanding or not.
    service.flushSync();
    await settle();
    mcp.finish("too late");
    await settle();
    expect(reports(messages)).toHaveLength(0);
    const entries = stored(lastState(messages).conversationId)!.entries;
    expect(entries[entries.length - 1]).toMatchObject({ kind: "assistant", stopped: true });
  }, 5000);
});

describe("token, cost and context accounting", () => {
  const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): FakeUsage => ({ input, output, cacheRead, cacheWrite });

  const usageMsgs = (messages: ChatToWebview[]) =>
    messages.filter((m): m is Extract<ChatToWebview, { type: "usage" }> => m.type === "usage");
  const latestUsage = (messages: ChatToWebview[]) => {
    const seen = usageMsgs(messages);
    return seen[seen.length - 1].usage;
  };

  it("reports nothing until a turn actually costs something", async () => {
    const { messages, post } = makeService();
    post({ type: "chatReady" });
    await settle();
    expect(lastState(messages).usage).toBeUndefined();
  });

  it("accumulates across the iterations of a single turn", async () => {
    // Every tool round trip is a separate billed request, so a turn that used
    // three iterations must report all three — not just the last.
    const { provider, mcp, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("calling", { id: "t1", name: "cad__inspect", argsJson: "{}" }, usage(100, 10));
    await settle(4);
    mcp.finish("tool output");
    await settle(4);
    provider.finish("done", undefined, usage(250, 20));
    await settle();

    const latest = latestUsage(messages);
    expect(latest).toMatchObject({ input: 350, output: 30 });
    // lastInput is the most recent request alone — the context question, not
    // the cost question.
    expect(latest.lastInput).toBe(250);
  });

  it("prices a known model and reports its context window", async () => {
    stateValues.llmModelAnthropic = "claude-opus-4-8";
    const { provider, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("done", undefined, usage(1_000_000, 0));
    await settle();
    const latest = latestUsage(messages);
    expect(latest.contextWindow).toBe(1_000_000);
    expect(latest.costUsd).toBeCloseTo(5, 6);
    expect(latest.model).toBe("claude-opus-4-8");
  });

  it("reports tokens but no price or window for a model it has no figures for", async () => {
    // An Ollama or OpenRouter id: counts are real, a price would be invented.
    stateValues.llmProvider = "openai";
    stateValues.llmModelOpenai = "llama3.1:70b";
    const { provider, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("done", undefined, usage(500, 50));
    await settle();
    const latest = latestUsage(messages);
    expect(latest).toMatchObject({ input: 500, output: 50 });
    expect(latest.costUsd).toBeUndefined();
    expect(latest.contextWindow).toBeUndefined();
  });

  it("leaves the total untouched when a provider reports nothing", async () => {
    const { provider, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("done");
    await settle();
    expect(usageMsgs(messages)).toHaveLength(0);
    expect(lastState(messages).usage).toBeUndefined();
  });

  it("survives a quit and comes back with the conversation", async () => {
    // A lifetime cost that silently reset on restart would be worse than none.
    const { service, provider, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("done", undefined, usage(120, 30, 900, 40));
    await settle();
    const id = lastState(messages).conversationId;
    service.flushSync();

    expect(stored(id)!.usage).toEqual({ input: 120, output: 30, cacheRead: 900, cacheWrite: 40, lastInput: 1060 });
  });

  it("keeps each conversation's total to itself", async () => {
    const { provider, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("done", undefined, usage(400, 40));
    await settle();
    const before = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).not.toBe(before));
    expect(lastState(messages).usage).toBeUndefined();
  });

  it("replays the total on reload", async () => {
    const { provider, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("done", undefined, usage(70, 7));
    await settle();
    post({ type: "chatReady" });
    await settle();
    expect(lastState(messages).usage).toMatchObject({ input: 70, output: 7 });
  });
});

describe("transcript compaction", () => {
  const usage = (input: number): FakeUsage => ({ input, output: 10, cacheRead: 0, cacheWrite: 0 });
  const overflow = () => new ProviderError("context", "prompt is too long: 1051277 tokens > 1000000 maximum");

  const compactionMsgs = (messages: ChatToWebview[]) =>
    messages.filter((m): m is Extract<ChatToWebview, { type: "compaction" }> => m.type === "compaction");
  const resultTexts = (entries: any[]) => entries.filter((e) => e.kind === "toolResult").map((e) => e.text);

  /** Drives a turn to completion with one tool round trip, so the conversation
   *  holds a clearable result. */
  const withOneToolResult = async (
    post: ReturnType<typeof makeService>["post"],
    provider: FakeProvider,
    mcp: FakeMcp
  ) => {
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("calling", { id: "t1", name: "cad__inspect", argsJson: "{}" });
    await settle(4);
    mcp.finish("a very long tool result");
    await settle(4);
  };

  it("recovers from a context overflow by clearing older results and retrying once", async () => {
    const { provider, mcp, messages, post } = makeService();
    await withOneToolResult(post, provider, mcp);

    const before = provider.turns;
    provider.fail(overflow());
    await settle(6);

    expect(provider.turns).toBe(before + 1); // retried exactly once
    expect(compactionMsgs(messages)).toMatchObject([{ count: 1 }]);
    // The retry was sent a smaller transcript than the attempt that overflowed.
    expect(resultTexts(provider.lastEntries)).toEqual([CLEARED_PLACEHOLDER]);

    provider.finish("done");
    await settle();
  });

  it("emits one assistantStart for the iteration, not one per attempt", async () => {
    // The renderer opens a fresh assistant bubble on each of these, so the retry
    // must not emit a second one or it strands an empty bubble in the
    // transcript. This is why the retry wraps the streamTurn call alone rather
    // than re-entering the loop body.
    const { provider, mcp, messages, post } = makeService();
    await withOneToolResult(post, provider, mcp);
    const beforeRetry = messages.filter((m) => m.type === "assistantStart").length;
    provider.fail(overflow());
    await settle(6);
    provider.finish("done");
    await settle();
    expect(messages.filter((m) => m.type === "assistantStart").length).toBe(beforeRetry);
  });

  it("gives up and shows the banner when there is nothing left to clear", async () => {
    const { provider, mcp, messages, post } = makeService();
    await withOneToolResult(post, provider, mcp);

    provider.fail(overflow());
    await settle(6);
    const afterFirst = provider.turns;
    provider.fail(overflow()); // the retry overflows too, and now nothing is left
    await settle(6);

    // Bounded: no third attempt, no loop.
    expect(provider.turns).toBe(afterFirst);
    const errors = messages.filter((m) => m.type === "entry" && (m as any).entry.kind === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as any).entry.errorKind).toBe("context");
  });

  it("leaves the stored transcript and the sidebar showing the full result", async () => {
    // Compaction shapes the request only — this is the whole point.
    const { service, provider, mcp, messages, post } = makeService();
    await withOneToolResult(post, provider, mcp);
    provider.fail(overflow());
    await settle(6);
    provider.finish("done");
    await settle();
    service.flushSync();

    const id = lastState(messages).conversationId;
    expect(resultTexts(stored(id)!.entries)).toEqual(["a very long tool result"]);
    const wire = messages.filter((m) => m.type === "entry" && (m as any).entry.kind === "toolResult");
    expect((wire[0] as any).entry.preview).toBe("a very long tool result");
  });

  it("clears proactively once a known window is filling up", async () => {
    stateValues.llmModelAnthropic = "claude-haiku-4-5"; // 200k window
    const { provider, mcp, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("calling", { id: "t1", name: "cad__inspect", argsJson: "{}" }, usage(150_000));
    await settle(4);
    mcp.finish("output");
    await settle(4);
    provider.finish("done", undefined, usage(180_000)); // past 70% of 200k
    await settle();
    expect(compactionMsgs(messages).length).toBeGreaterThan(0);
  });

  it("does not compact proactively for a model whose window is unknown", async () => {
    stateValues.llmProvider = "openai";
    stateValues.llmModelOpenai = "llama3.1:70b";
    const { provider, mcp, messages, post } = makeService();
    post({ type: "chatReady" });
    await send(post, "go");
    provider.finish("calling", { id: "t1", name: "cad__inspect", argsJson: "{}" }, usage(999_999));
    await settle(4);
    mcp.finish("output");
    await settle(4);
    provider.finish("done", undefined, usage(999_999));
    await settle();
    expect(compactionMsgs(messages)).toHaveLength(0);
  });

  it("keeps the boundary across a conversation switch away and back", async () => {
    const { provider, mcp, messages, post } = makeService();
    await withOneToolResult(post, provider, mcp);
    provider.fail(overflow());
    await settle(6);
    provider.finish("done");
    await settle();
    const id = lastState(messages).conversationId;

    post({ type: "newChat" });
    await settle();
    post({ type: "selectConversation", id });
    await settleAfterSwitch(() => expect(lastState(messages).conversationId).toBe(id));
    expect(lastState(messages).compactedResults).toBe(1);
  });
});
