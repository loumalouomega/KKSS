/**
 * McpHub — the contract Home relies on: `ensureStarted()` must begin connecting
 * the servers *synchronously*. Raw callers (Home's workflow tools, the HTTP meta
 * server) call `ensureStarted()` and immediately `callToolRaw()`, which waits on
 * the manager's pending-connection map; if the connections were only begun a
 * microtask later, that map would be empty and the call would answer
 * "unavailable: not connected" although the server was about to be ready.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const fake = vi.hoisted(() => ({ spawned: [] as string[] }));
vi.mock("electron", async () => {
  const { electronStub } = await import("./stubs/electron");
  return { app: electronStub.app, ipcMain: electronStub.ipcMain, safeStorage: electronStub.safeStorage };
});
vi.mock("../app/main/services/stateStore", () => ({
  stateStore: { get: <T,>(_key: string, defaultValue?: T) => defaultValue, onDidChange: () => ({ dispose() {} }) },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = new EventEmitter();
    close = vi.fn(async () => {});
    constructor(public options: any) { fake.spawned.push(options.command); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { close = vi.fn(async () => {}); },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose?: () => void;
    close = vi.fn(async () => {});
    // A connect that takes a real tick, like a child process handshake.
    connect = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    listTools = vi.fn(async () => ({ tools: [{ name: "inspect", inputSchema: { type: "object" } }] }));
    getServerVersion = () => ({ name: "test" });
  },
}));

const { McpHub } = await import("../app/main/services/chat/mcpHub");

beforeEach(() => { fake.spawned = []; });

describe("McpHub.ensureStarted", () => {
  it("lets a raw call made straight away wait for the server instead of failing", async () => {
    const hub = new McpHub("/tmp/out");
    const manager = hub.ensureStarted();
    const result = await manager.callToolRaw("cad__inspect", {});
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("ok");
    await hub.dispose();
  });

  it("starts each server once, however many callers ask", async () => {
    const hub = new McpHub("/tmp/out");
    expect(hub.ensureStarted()).toBe(hub.ensureStarted());
    await hub.ensureStarted().callToolRaw("mesh__inspect", {});
    expect(fake.spawned.filter((command) => command === process.execPath)).toHaveLength(2); // cad + mesh
    await hub.dispose();
  });

  it("includes configured servers from the first status, and never spawns a blocked one", async () => {
    const specs = [
      { key: "acme", name: "Acme", source: "user" as const, command: "acme-cmd", args: [], env: {}, revision: "r1" },
      { key: "lab", name: "Lab", source: "project" as const, command: "lab-cmd", args: [], env: {}, revision: "r1", blocked: "untrusted" as const },
    ];
    const store = { specs: () => specs, onChange: () => undefined } as never;
    const hub = new McpHub("/tmp/out", store);
    const manager = hub.ensureStarted();
    expect(manager.statuses().map((s) => [s.key, s.state])).toEqual(
      expect.arrayContaining([["acme", "starting"], ["lab", "untrusted"]])
    );
    expect((await manager.callToolRaw("acme__inspect", {})).isError).toBeFalsy();
    expect(fake.spawned).toContain("acme-cmd");
    expect(fake.spawned).not.toContain("lab-cmd");
    await hub.dispose();
  });
});
