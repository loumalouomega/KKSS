/**
 * The HTTP meta MCP server, driven by a real MCP Client over StreamableHTTP.
 * A fake hub/manager avoids spawning the three real child servers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpHub } from "../app/main/services/chat/mcpHub";
import { MetaMcpServer } from "../app/main/services/metaServer/metaServer";
import type { MetaAccessPolicy } from "../app/main/services/metaServer/accessPolicy";

const TOKEN = "test-secret-token";
const TOOLS = [
  { name: "cad__load_model", description: "load", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "mesh__mesh_info", description: "info", inputSchema: { type: "object", properties: {} } },
  { name: "mesh__mesh_transform", description: "write", inputSchema: { type: "object", properties: {} } },
  { name: "cad__brand_new_tool", description: "unclassified", inputSchema: { type: "object", properties: {} } },
];

/** Minimal McpManager stand-in exposing only what buildMetaServer touches. */
const fakeManager = {
  tools: () => TOOLS,
  callToolRaw: async (name: string, args: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify({ name, args }) }],
  }),
  listResources: async () => [{ uri: "kratos://examples/beam", name: "Beam" }],
  readResource: async (uri: string) => ({ contents: [{ uri, text: "example" }] }),
  listPrompts: async () => [] as unknown[],
  getPrompt: async () => ({ messages: [] }),
};

/** Fake hub: no child processes, no status fan-out. */
const fakeHub = {
  ensureStarted: () => fakeManager,
  onStatus: () => {},
  offStatus: () => {},
} as unknown as McpHub;

let server: MetaMcpServer;
let policy: MetaAccessPolicy;

async function connect(headers: Record<string, string>): Promise<Client> {
  const url = new URL(server.address()!);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("MetaMcpServer", () => {
  beforeEach(async () => {
    policy = { access: "all", allowedWrites: new Set() };
    server = new MetaMcpServer({ hub: fakeHub, version: "test", port: () => 0, token: () => TOKEN, access: () => policy });
    await server.enable();
  });
  afterEach(async () => {
    await server.dispose();
  });

  it("advertises the aggregated namespaced tools", async () => {
    const client = await connect(auth);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["cad__brand_new_tool", "cad__load_model", "mesh__mesh_info", "mesh__mesh_transform"]);
    await client.close();
  });

  it("round-trips a tool call through callToolRaw", async () => {
    const client = await connect(auth);
    const result = await client.callTool({ name: "cad__load_model", arguments: { path: "/abs/x.step" } });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ name: "cad__load_model", args: { path: "/abs/x.step" } });
    await client.close();
  });

  it("rejects a request without the bearer token", async () => {
    await expect(connect({})).rejects.toThrow();
  });

  describe("access policy", () => {
    const call = async (name: string) => {
      const client = await connect(auth);
      try {
        return await client.callTool({ name, arguments: {} });
      } finally {
        await client.close();
      }
    };

    it("readOnly lists and runs only read tools", async () => {
      policy = { access: "readOnly", allowedWrites: new Set() };
      const client = await connect(auth);
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["cad__load_model", "mesh__mesh_info"]);
      await client.close();
      expect((await call("mesh__mesh_info")).isError).toBeFalsy();
    });

    it("refuses a write tool with an explanatory MCP error", async () => {
      policy = { access: "readOnly", allowedWrites: new Set() };
      const result = await call("mesh__mesh_transform");
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toMatch(/not permitted.*"readOnly".*Settings/s);
    });

    it("refuses an unclassified tool unless the mode is all", async () => {
      policy = { access: "readOnly", allowedWrites: new Set() };
      expect((await call("cad__brand_new_tool")).isError).toBe(true);
      policy = { access: "readListed", allowedWrites: new Set(["mesh__mesh_transform"]) };
      expect((await call("cad__brand_new_tool")).isError).toBe(true);
    });

    it("readListed runs exactly the listed writes", async () => {
      policy = { access: "readListed", allowedWrites: new Set(["mesh__mesh_transform"]) };
      expect((await call("mesh__mesh_transform")).isError).toBeFalsy();
      expect((await call("mesh__mesh_info")).isError).toBeFalsy();
      policy = { access: "readListed", allowedWrites: new Set() };
      expect((await call("mesh__mesh_transform")).isError).toBe(true);
    });

    it("applies a setting change to a live session", async () => {
      policy = { access: "readOnly", allowedWrites: new Set() };
      const client = await connect(auth);
      const first = await client.callTool({ name: "mesh__mesh_transform", arguments: {} });
      expect(first.isError).toBe(true);
      policy = { access: "all", allowedWrites: new Set() };
      const second = await client.callTool({ name: "mesh__mesh_transform", arguments: {} });
      expect(second.isError).toBeFalsy();
      await client.close();
    });
  });
});
