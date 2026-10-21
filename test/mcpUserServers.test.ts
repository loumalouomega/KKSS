import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const fake = vi.hoisted(() => ({
  clients: [] as any[], stdio: [] as any[], http: [] as any[],
  tools: [{ name: "lookup", description: "d", inputSchema: { type: "object" } }] as any[],
  failFor: "" as string,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = new EventEmitter();
    close = vi.fn(async () => {});
    constructor(public options: any) { fake.stdio.push(this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn(async () => {});
    constructor(public url: URL, public options: any) { fake.http.push(this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    transport: any;
    onclose?: () => void;
    close = vi.fn(async () => {});
    connect = vi.fn(async (transport: any) => {
      this.transport = transport;
      if (fake.failFor && transport.options?.command === fake.failFor) throw new Error("spawn failed");
    });
    callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    listTools = vi.fn(async () => ({ tools: fake.tools }));
    listResources = vi.fn(async () => ({ resources: [{ uri: `res://${this.transport?.options?.command ?? "http"}`, name: "r" }] }));
    listPrompts = vi.fn(async () => ({ prompts: [{ name: "p" }] }));
    readResource = vi.fn(async () => ({ contents: [{ uri: "x", text: "secret" }] }));
    getPrompt = vi.fn(async () => ({ messages: [] }));
    getServerVersion = () => ({ name: "announced-name" });
    constructor() { fake.clients.push(this); }
  },
}));
import { McpManager, type ServerSpec } from "../app/main/services/chat/mcpManager";

const builtin = (key: string): ServerSpec => ({ key, name: key, command: key, args: [], env: {} });
const user = (key: string, over: Partial<ServerSpec> = {}): ServerSpec => ({ key, name: `User ${key}`, source: "user", command: `cmd-${key}`, args: ["a"], env: {}, revision: "r1", ...over });
beforeEach(() => { fake.clients = []; fake.stdio = []; fake.http = []; fake.failFor = ""; fake.tools = [{ name: "lookup", description: "d", inputSchema: { type: "object" } }]; });

describe("built-in statuses stay byte-identical", () => {
  it("carries no source or transport", async () => {
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.start();
    expect(manager.statuses()[0]).toEqual({ key: "cad", name: "announced-name", state: "ready", toolCount: 1 });
    await manager.dispose();
  });
});

describe("user servers", () => {
  it("connects over stdio with the SDK's default environment plus resolved secrets", async () => {
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.setUserServers([user("acme", { resolveEnv: () => ({ API_KEY: "k" }) })]);
    await manager.start();
    const spawned = fake.stdio.find((t) => t.options.command === "cmd-acme");
    expect(spawned.options).toMatchObject({ command: "cmd-acme", args: ["a"], env: { API_KEY: "k" } });
    expect(manager.tools().map((t) => t.name)).toContain("acme__lookup");
    // The user's own name beats whatever the server announces.
    expect(manager.statuses().find((s) => s.key === "acme")).toEqual({
      key: "acme", name: "User acme", source: "user", transport: "stdio", state: "ready", toolCount: 1,
    });
    await manager.dispose();
  });
  it("connects over streamable HTTP with a bearer header and no redirects", async () => {
    const manager = new McpManager([], vi.fn());
    await manager.setUserServers([user("web", { http: { url: "https://x.test/mcp", token: () => "tok" } })]);
    await manager.start();
    expect(fake.http).toHaveLength(1);
    expect(fake.http[0].url.href).toBe("https://x.test/mcp");
    expect(fake.http[0].options.requestInit).toEqual({ redirect: "error", headers: { Authorization: "Bearer tok" } });
    expect(manager.statuses()[0]).toMatchObject({ transport: "http", state: "ready" });
    // The token is never part of a status.
    expect(JSON.stringify(manager.statuses())).not.toContain("tok\"");
    await manager.dispose();
  });
  it("omits the Authorization header without a token", async () => {
    const manager = new McpManager([], vi.fn());
    await manager.setUserServers([user("web", { http: { url: "http://127.0.0.1:9/mcp" } })]);
    await manager.start();
    expect(fake.http[0].options.requestInit).toEqual({ redirect: "error" });
    await manager.dispose();
  });
  it("does not spawn a disabled or untrusted server, and shows why", async () => {
    const manager = new McpManager([], vi.fn());
    await manager.setUserServers([user("off", { blocked: "disabled" }), user("proj", { source: "project", blocked: "untrusted" })]);
    await manager.start();
    expect(fake.stdio).toHaveLength(0);
    expect(manager.statuses().map((s) => [s.key, s.state])).toEqual([["off", "disabled"], ["proj", "untrusted"]]);
    expect(manager.tools()).toEqual([]);
    await manager.dispose();
  });
  it("re-checks a project server's trust at every spawn, including a restart", async () => {
    let trusted = true;
    const manager = new McpManager([], vi.fn());
    await manager.setUserServers([user("proj", { source: "project", preflight: () => (trusted ? null : "untrusted") })]);
    await manager.start();
    expect(manager.statuses()[0].state).toBe("ready");
    trusted = false;
    await manager.restartServer("proj");
    expect(manager.statuses()[0].state).toBe("untrusted");
    expect(fake.stdio).toHaveLength(1);
    expect(manager.tools()).toEqual([]);
    expect(fake.clients[0].close).toHaveBeenCalled();
    await manager.dispose();
  });
  it("a failing user server is unavailable and does not affect the others", async () => {
    fake.failFor = "cmd-bad";
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.setUserServers([user("bad"), user("good")]);
    await manager.start();
    const byKey = Object.fromEntries(manager.statuses().map((s) => [s.key, s.state]));
    expect(byKey).toEqual({ cad: "ready", bad: "unavailable", good: "ready" });
    await manager.dispose();
  });
  it("leaves out tools whose namespaced name a model provider would reject", async () => {
    fake.tools = [{ name: "ok_tool", inputSchema: {} }, { name: "has space", inputSchema: {} }, { name: "x".repeat(70), inputSchema: {} }, { name: "dots.name", inputSchema: {} }];
    const manager = new McpManager([], vi.fn());
    await manager.setUserServers([user("acme")]);
    await manager.start();
    expect(manager.tools().map((t) => t.name)).toEqual(["acme__ok_tool"]);
    expect(manager.statuses()[0]).toMatchObject({ toolCount: 1, skippedTools: 3 });
    expect(manager.toolList("acme")).toEqual([{ name: "ok_tool" }]);
    await manager.dispose();
  });
  it("routes calls to a user server and refuses unknown ones", async () => {
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.setUserServers([user("acme")]);
    await manager.start();
    expect(await manager.callTool("acme__lookup", "{}")).toMatchObject({ ok: true, text: "ok" });
    expect(await manager.callTool("ghost__lookup", "{}")).toMatchObject({ ok: false });
    await manager.dispose();
  });
});

describe("resources and prompts stay a built-in-only path", () => {
  it("never aggregates, reads or renders a user server's", async () => {
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.setUserServers([user("acme")]);
    await manager.start();
    expect((await manager.listResources()).map((r) => r.uri)).toEqual(["res://cad"]);
    expect((await manager.listPrompts()).map((p) => p.name)).toEqual(["cad__p"]);
    await expect(manager.getPrompt("acme__p", {})).rejects.toThrow(/Unknown prompt/);
    const acme = fake.clients.find((c) => c.transport.options.command === "cmd-acme");
    // An unseen uri is offered to the built-in servers only; the user server is never asked.
    await manager.readResource("res://cmd-acme");
    expect(acme.readResource).not.toHaveBeenCalled();
    expect(acme.listResources).not.toHaveBeenCalled();
    expect(acme.listPrompts).not.toHaveBeenCalled();
    await manager.dispose();
  });
});

describe("reconciling the user servers", () => {
  it("leaves an unchanged server running, reconnects an edited one and closes a removed one", async () => {
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.setUserServers([user("a"), user("b")]);
    await manager.start();
    expect(fake.clients).toHaveLength(3);
    const [, a, b] = fake.clients;
    await manager.setUserServers([user("a"), user("b", { revision: "r2" })]);
    expect(a.close).not.toHaveBeenCalled();
    expect(fake.clients).toHaveLength(4);
    expect(b.close).toHaveBeenCalled();
    await manager.setUserServers([user("a")]);
    expect(manager.statuses().map((s) => s.key)).toEqual(["cad", "a"]);
    await manager.dispose();
  });
  it("is lazy before start and never touches or shadows a built-in", async () => {
    const manager = new McpManager([builtin("cad")], vi.fn());
    await manager.setUserServers([user("a"), user("cad")]);
    expect(fake.stdio).toHaveLength(0);
    expect(manager.statuses().map((s) => s.key)).toEqual(["cad", "a"]);
    await manager.dispose();
  });
  it("disabling closes a running server; enabling starts it again", async () => {
    const manager = new McpManager([], vi.fn());
    await manager.setUserServers([user("a")]);
    await manager.start();
    await manager.setUserServers([user("a", { blocked: "disabled" })]);
    expect(manager.statuses()[0].state).toBe("disabled");
    expect(manager.tools()).toEqual([]);
    await manager.setUserServers([user("a", { revision: "r1" })]);
    expect(manager.statuses()[0].state).toBe("ready");
    await manager.dispose();
  });
});
