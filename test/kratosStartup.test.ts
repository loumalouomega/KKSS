import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const fake = vi.hoisted(() => ({ clients: [] as any[], transports: [] as any[], fail: false, hold: false }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = new EventEmitter();
    close = vi.fn(async () => {});
    constructor(public options: any) { fake.transports.push(this); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    transport: any;
    onclose?: () => void;
    close = vi.fn(async () => {});
    connect = vi.fn(async (transport: any, options: any) => {
      this.transport = transport;
      if (transport.options.command === "uv") {
        if (fake.fail) {
          transport.stderr.emit("data", Buffer.from("No solution found when resolving dependencies"));
          throw new Error("connection closed");
        }
        if (fake.hold) await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
    });
    listTools = vi.fn(async () => ({ tools: [{ name: "inspect", inputSchema: { type: "object" } }] }));
    getServerVersion = () => ({ name: "test" });
    constructor() { fake.clients.push(this); }
  },
}));
import { McpManager } from "../app/main/services/chat/mcpManager";
import { RuntimeFailure } from "../app/main/services/chat/kratosRuntime";

function harness() {
  let installed = false;
  const runtime = {
    discover: vi.fn(async (_signal: AbortSignal) => {
      if (!installed) throw new RuntimeFailure("missing-runtime", "uv missing");
      return { command: "uv", args: ["tool", "run"] };
    }),
    install: vi.fn(async (_signal: AbortSignal) => { installed = true; }),
  };
  const statuses = vi.fn();
  const manager = new McpManager(["cad", "mesh", "kratos"].map((key) => ({
    key: key as "cad" | "mesh" | "kratos", name: key, command: key, args: ["server"], env: {},
  })), statuses, runtime);
  return { manager, runtime, statuses };
}
beforeEach(() => { fake.clients = []; fake.transports = []; fake.fail = false; fake.hold = false; });

describe("Kratos recovery lifecycle", () => {
  it("does not auto-install and retries only Kratos, deduplicating clicks", async () => {
    const { manager, runtime } = harness();
    await manager.start();
    expect(runtime.install).not.toHaveBeenCalled();
    expect(manager.statuses()[2]).toMatchObject({ state: "unavailable", failure: "missing-runtime" });
    const first = manager.retryKratos(true);
    expect(manager.retryKratos(true)).toBe(first);
    await first;
    expect(runtime.install).toHaveBeenCalledTimes(1);
    expect(fake.clients).toHaveLength(3);
    expect(manager.tools().map((t) => t.name)).toEqual(["cad__inspect", "mesh__inspect", "kratos__inspect"]);
    expect(fake.clients[0].close).not.toHaveBeenCalled();
    expect(fake.clients[1].close).not.toHaveBeenCalled();
    expect(fake.clients[2].connect.mock.calls[0][1].timeout).toBe(300_000);
    expect(fake.clients[0].connect.mock.calls[0][1].timeout).toBe(60_000);
    await manager.retryKratos(true);
    expect(runtime.install).toHaveBeenCalledTimes(1);
    await manager.dispose();
  });
  it("closes failed transports and reports package diagnostics, then recovers", async () => {
    const { manager } = harness();
    await manager.start();
    fake.fail = true;
    await manager.retryKratos(true);
    expect(manager.statuses()[2]).toMatchObject({ failure: "package" });
    expect(fake.clients[2].close).toHaveBeenCalled();
    expect(fake.transports[2].close).toHaveBeenCalled();
    expect(manager.tools()).toHaveLength(2);
    fake.fail = false;
    await manager.retryKratos();
    expect(manager.statuses()[2].state).toBe("ready");
    fake.clients[3].onclose();
    expect(manager.tools()).toHaveLength(2);
    expect(manager.statuses()[2].state).toBe("unavailable");
    await manager.dispose();
  });
  it("cancels an in-flight connection on shutdown and never publishes ready afterwards", async () => {
    const { manager, statuses } = harness();
    await manager.start();
    fake.hold = true;
    const pending = manager.retryKratos(true);
    await vi.waitFor(() => expect(fake.clients).toHaveLength(3));
    await manager.dispose();
    await pending;
    expect(manager.tools()).toHaveLength(0);
    expect(statuses.mock.calls.flatMap(([s]) => s).some((s: any) => s.key === "kratos" && s.state === "ready")).toBe(false);
    await manager.retryKratos();
    expect(fake.clients).toHaveLength(3);
  });
  it("aborts installation on shutdown", async () => {
    const { manager, runtime } = harness();
    runtime.install.mockImplementation(async (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    await manager.start();
    const pending = manager.retryKratos(true);
    await vi.waitFor(() => expect(runtime.install).toHaveBeenCalled());
    await manager.dispose();
    await pending;
    expect(fake.clients).toHaveLength(2);
  });
});
