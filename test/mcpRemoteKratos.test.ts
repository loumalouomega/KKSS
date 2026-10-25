/** Settings ▸ Remote ▸ Run Kratos tools on: the Kratos server is launched through ssh. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const fake = vi.hoisted(() => ({
  spawned: [] as Array<{ command: string; args: string[] }>,
  remoteHost: "" as string,
}));
vi.mock("electron", async () => {
  const { electronStub } = await import("./stubs/electron");
  return { app: electronStub.app, ipcMain: electronStub.ipcMain, safeStorage: electronStub.safeStorage };
});
vi.mock("../app/main/services/stateStore", () => ({
  stateStore: {
    get: <T,>(key: string, defaultValue?: T) => (key === "remote.kratosHost" && fake.remoteHost ? fake.remoteHost : defaultValue),
    onDidChange: () => ({ dispose() {} }),
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    stderr = new EventEmitter();
    close = vi.fn(async () => {});
    constructor(options: { command: string; args: string[] }) {
      fake.spawned.push({ command: options.command, args: options.args });
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { close = vi.fn(async () => {}); },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose?: () => void;
    close = vi.fn(async () => {});
    connect = vi.fn(async () => {});
    listTools = vi.fn(async () => ({ tools: [{ name: "job_list", inputSchema: { type: "object" } }] }));
    getServerVersion = () => ({ name: "kratos" });
  },
}));

const { McpHub } = await import("../app/main/services/chat/mcpHub");
const { kratosRemoteHost } = await import("../app/main/services/settings/kratosEnv");

beforeEach(() => {
  fake.spawned = [];
  fake.remoteHost = "";
});

describe("remote Kratos MCP server", () => {
  it("ignores an unset or invalid host", () => {
    expect(kratosRemoteHost()).toBeUndefined();
    fake.remoteHost = "-oProxyCommand=evil";
    expect(kratosRemoteHost()).toBeUndefined();
    fake.remoteHost = "me@cluster";
    expect(kratosRemoteHost()).toBe("me@cluster");
  });

  it("spawns ssh with BatchMode and the pinned uvx command instead of a local uv", async () => {
    fake.remoteHost = "cluster";
    const hub = new McpHub("/tmp/out");
    const manager = hub.ensureStarted();
    await manager.callToolRaw("kratos__job_list", {}).catch(() => undefined);
    const ssh = fake.spawned.find((s) => s.command === "ssh");
    expect(ssh).toBeDefined();
    expect(ssh!.args).toContain("BatchMode=yes");
    expect(ssh!.args).toContain("cluster");
    expect(ssh!.args[ssh!.args.length - 1]).toMatch(/exec uvx '--with' 'mcp<2' 'kratos-mcp-server@\d/);
    await hub.dispose();
  });
});
