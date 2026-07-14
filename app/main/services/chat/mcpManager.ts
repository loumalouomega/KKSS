/**
 * MCP client manager for the chat agent: spawns the three stdio MCP servers
 * (cad = cad-preview bundle, mesh = kratos-mdpa bundle, kratos =
 * kratos-mcp-server from PyPI via uvx, pinned to KRATOS_MCP_VERSION),
 * aggregates their tools, resources and prompts under namespaced names
 * ("cad__load_model") and routes calls back.
 *
 * The cad/mesh bundles are Node CJS scripts run with Electron's own binary
 * (ELECTRON_RUN_AS_NODE=1) so no system Node is required in packaged builds.
 * StdioClientTransport strips the environment to a minimal default set, so
 * process.env is always spread in explicitly — otherwise PATH is lost and
 * `uvx` can never be found.
 *
 * Failure of any single server (typically kratos when uv is not installed)
 * marks it "unavailable" and the chat continues with the remaining tools.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, GetPromptResult, Prompt, ReadResourceResult, Resource } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import type { ChatServerStatus } from "../../ipc";
import { truncate } from "./transcript";
import type { ToolDef } from "./providers/types";

export type ServerKey = ChatServerStatus["key"];

export interface ServerSpec {
  key: ServerKey;
  /** Display name until the server reports its own. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Pinned kratos-mcp-server release (uvx resolves this exact version). Bump on
 *  upgrade; the tool/resource/prompt surface is discovered at runtime. */
export const KRATOS_MCP_VERSION = "0.3.0";

const NAMESPACE_SEPARATOR = "__";
/** Cap on tool-result text handed back to the model. */
export const RESULT_CHARS = 50_000;
/** uvx cold-starts by downloading the package — allow a slow first connect. */
const CONNECT_TIMEOUT_MS = 60_000;
/** Meshing/simulation tools can legitimately run for minutes. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Reserved prefix for the aggregated resource/prompt tools (not a real server). */
export const META_NAMESPACE = "mcp";
/** Synthetic tools that expose the servers' MCP resources & prompts to the chat
 *  provider loop (which only understands tools). The HTTP meta server exposes the
 *  same resources/prompts *natively* instead, so these are chat-only. */
const META_TOOLS: ToolDef[] = [
  {
    name: `${META_NAMESPACE}__list_resources`,
    description: "List worked-example and reference resources the MCP servers ship (name, uri, description).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: `${META_NAMESPACE}__read_resource`,
    description: "Read a resource by its uri (as returned by mcp__list_resources).",
    inputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"], additionalProperties: false },
  },
  {
    name: `${META_NAMESPACE}__list_prompts`,
    description: "List guided setup prompts the MCP servers ship (name, description, arguments).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: `${META_NAMESPACE}__get_prompt`,
    description: "Render a guided prompt by name (from mcp__list_prompts), passing any required arguments.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

export function namespaceTool(key: ServerKey, tool: string): string {
  return `${key}${NAMESPACE_SEPARATOR}${tool}`;
}

/** Splits "cad__load_model" → {server:"cad", tool:"load_model"}; null if unknown. */
export function splitToolName(namespaced: string, keys: readonly string[]): { server: string; tool: string } | null {
  const index = namespaced.indexOf(NAMESPACE_SEPARATOR);
  if (index <= 0) return null;
  const server = namespaced.slice(0, index);
  const tool = namespaced.slice(index + NAMESPACE_SEPARATOR.length);
  if (!keys.includes(server) || !tool) return null;
  return { server, tool };
}

/** Joins the text blocks of an MCP tool result into one string. */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return `[${String((block as { type?: string })?.type ?? "unknown")} content]`;
    })
    .join("\n");
}

/** The three server specs, resolved relative to out/ (== __dirname of main.js). */
export function buildServerSpecs(outDir: string): ServerSpec[] {
  const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" } as Record<string, string>;
  return [
    {
      key: "cad",
      name: "cad-preview",
      command: process.execPath,
      // Beside the OCCT/Gmsh WASM: extensionPath resolves to out/cad-runtime.
      args: [path.join(outDir, "cad-runtime", "dist", "mcp-server.js")],
      env: { ...nodeEnv, CAD_PREVIEW_ROOT: path.join(outDir, "cad-runtime") },
    },
    {
      key: "mesh",
      name: "kratos-mdpa",
      // Beside out/mmg-core.wasm (the bundle reads __dirname/mmg-core.wasm).
      command: process.execPath,
      args: [path.join(outDir, "mcpServer.js")],
      env: nodeEnv,
    },
    {
      key: "kratos",
      name: "kratos-mcp-server",
      command: "uvx",
      args: [`kratos-mcp-server@${KRATOS_MCP_VERSION}`],
      env: { ...process.env } as Record<string, string>,
    },
  ];
}

interface ServerState {
  spec: ServerSpec;
  status: ChatServerStatus;
  client: Client | null;
  tools: ToolDef[];
}

export class McpManager {
  private readonly servers: ServerState[];
  private started = false;
  /** uri → owning server, rebuilt on each listResources() (URIs aren't namespaced). */
  private readonly resourceOwners = new Map<string, ServerState>();

  constructor(
    specs: ServerSpec[],
    private readonly onStatus: (statuses: ChatServerStatus[]) => void
  ) {
    this.servers = specs.map((spec) => ({
      spec,
      status: { key: spec.key, name: spec.name, state: "starting" },
      client: null,
      tools: [],
    }));
  }

  statuses(): ChatServerStatus[] {
    return this.servers.map((s) => ({ ...s.status }));
  }

  /** Spawns and connects all servers in parallel (idempotent). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.onStatus(this.statuses());
    await Promise.all(this.servers.map((server) => this.connect(server)));
  }

  private async connect(server: ServerState): Promise<void> {
    try {
      const transport = new StdioClientTransport({
        command: server.spec.command,
        args: server.spec.args,
        env: server.spec.env,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim()) console.log(`[mcp:${server.spec.key}] ${line}`);
        }
      });
      const client = new Client({ name: "kkss-chat", version: "1.0.0" });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const { tools } = await client.listTools();
      server.client = client;
      server.tools = tools.map((tool) => ({
        name: namespaceTool(server.spec.key, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      server.status = {
        key: server.spec.key,
        name: client.getServerVersion()?.name ?? server.spec.name,
        state: "ready",
        toolCount: server.tools.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[mcp:${server.spec.key}] unavailable: ${message}`);
      server.status = { key: server.spec.key, name: server.spec.name, state: "unavailable", error: truncate(message, 300) };
    }
    this.onStatus(this.statuses());
  }

  /** Real, namespaced tools aggregated across servers (used by the HTTP meta server). */
  tools(): ToolDef[] {
    return this.servers.flatMap((server) => server.tools);
  }

  /** tools() plus the synthetic resource/prompt tools — for the chat provider loop. */
  chatTools(): ToolDef[] {
    return [...this.tools(), ...META_TOOLS];
  }

  toolName = (server: string, tool: string): string => namespaceTool(server as ServerKey, tool);

  private ready(): ServerState[] {
    return this.servers.filter((s) => s.client);
  }

  /** Aggregated MCP resources across ready servers; records the owner of each uri. */
  async listResources(): Promise<Resource[]> {
    this.resourceOwners.clear();
    const out: Resource[] = [];
    await Promise.all(
      this.ready().map(async (server) => {
        try {
          const { resources } = await server.client!.listResources();
          for (const resource of resources) {
            this.resourceOwners.set(resource.uri, server);
            out.push(resource);
          }
        } catch {
          /* server without a resources capability — skip */
        }
      })
    );
    return out;
  }

  /** Reads a resource by uri, routing to its owner (falls back to scanning servers). */
  async readResource(uri: string): Promise<ReadResourceResult> {
    let owner = this.resourceOwners.get(uri);
    if (!owner) {
      await this.listResources(); // stale/unseen uri — refresh the owner map
      owner = this.resourceOwners.get(uri);
    }
    const candidates = owner ? [owner] : this.ready();
    let lastError = "no server served this uri";
    for (const server of candidates) {
      try {
        return await server.client!.readResource({ uri });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`Cannot read resource ${uri}: ${lastError}`);
  }

  /** Aggregated MCP prompts, names namespaced by owning server (e.g. "kratos__setup..."). */
  async listPrompts(): Promise<Prompt[]> {
    const out: Prompt[] = [];
    await Promise.all(
      this.ready().map(async (server) => {
        try {
          const { prompts } = await server.client!.listPrompts();
          for (const prompt of prompts) out.push({ ...prompt, name: namespaceTool(server.spec.key, prompt.name) });
        } catch {
          /* server without a prompts capability — skip */
        }
      })
    );
    return out;
  }

  /** Renders a namespaced prompt, routing to its owning server. */
  async getPrompt(namespaced: string, args: Record<string, string>): Promise<GetPromptResult> {
    const split = splitToolName(namespaced, this.servers.map((s) => s.spec.key));
    const server = split && this.servers.find((s) => s.spec.key === split.server);
    if (!split || !server?.client) throw new Error(`Unknown prompt: ${namespaced}`);
    return server.client.getPrompt({ name: split.tool, arguments: args });
  }

  /** Raw tool call that returns the untouched CallToolResult (used by the HTTP meta
   *  server so image/structured content survives). Never throws — errors become a
   *  CallToolResult with isError. */
  async callToolRaw(namespaced: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const split = splitToolName(namespaced, this.servers.map((s) => s.spec.key));
    const server = split && this.servers.find((s) => s.spec.key === split.server);
    if (!split || !server) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${namespaced}` }] };
    if (!server.client) return { isError: true, content: [{ type: "text", text: `MCP server "${server.status.name}" is unavailable: ${server.status.error ?? "not connected"}` }] };
    try {
      return (await server.client.callTool({ name: split.tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      })) as CallToolResult;
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `Tool call failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }

  /** Serves a synthetic mcp__* tool as flattened text for the chat loop. */
  private async callMetaTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    try {
      if (tool === "list_resources") {
        const resources = await this.listResources();
        const text = resources.map((r) => `- ${r.uri}${r.name ? `  (${r.name})` : ""}${r.description ? ` — ${r.description}` : ""}`).join("\n");
        return { ok: true, text: text || "(no resources available)" };
      }
      if (tool === "read_resource") {
        const uri = String(args.uri ?? "");
        if (!uri) return { ok: false, text: "read_resource requires a 'uri' argument." };
        const result = await this.readResource(uri);
        const text = (result.contents ?? []).map((c) => ("text" in c && typeof c.text === "string" ? c.text : `[${c.mimeType ?? "binary"} content]`)).join("\n");
        return { ok: true, text: text || "(empty resource)" };
      }
      if (tool === "list_prompts") {
        const prompts = await this.listPrompts();
        const text = prompts.map((p) => `- ${p.name}${p.description ? ` — ${p.description}` : ""}${p.arguments?.length ? ` [args: ${p.arguments.map((a) => a.name).join(", ")}]` : ""}`).join("\n");
        return { ok: true, text: text || "(no prompts available)" };
      }
      if (tool === "get_prompt") {
        const name = String(args.name ?? "");
        if (!name) return { ok: false, text: "get_prompt requires a 'name' argument." };
        const result = await this.getPrompt(name, (args.arguments as Record<string, string>) ?? {});
        const text = (result.messages ?? [])
          .map((m) => `[${m.role}] ${m.content && typeof m.content === "object" && "text" in m.content ? String((m.content as { text?: unknown }).text ?? "") : "[non-text content]"}`)
          .join("\n");
        return { ok: true, text: text || result.description || "(empty prompt)" };
      }
      return { ok: false, text: `Unknown meta tool: ${tool}` };
    } catch (error) {
      return { ok: false, text: `Meta tool failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Routes a namespaced tool call; never throws — errors become tool results. */
  async callTool(namespaced: string, argsJson: string): Promise<{ ok: boolean; text: string }> {
    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, text: `Invalid JSON arguments for ${namespaced}` };
    }

    // Synthetic resource/prompt tools are served from the aggregation layer, not a child.
    if (namespaced.startsWith(`${META_NAMESPACE}${NAMESPACE_SEPARATOR}`)) {
      return this.callMetaTool(namespaced.slice(META_NAMESPACE.length + NAMESPACE_SEPARATOR.length), args);
    }

    const split = splitToolName(
      namespaced,
      this.servers.map((s) => s.spec.key)
    );
    const server = split && this.servers.find((s) => s.spec.key === split.server);
    if (!split || !server) return { ok: false, text: `Unknown tool: ${namespaced}` };
    if (!server.client) return { ok: false, text: `MCP server "${server.status.name}" is unavailable: ${server.status.error ?? "not connected"}` };

    try {
      const result = await server.client.callTool({ name: split.tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      });
      const text = truncate(flattenContent(result.content), RESULT_CHARS);
      return { ok: !result.isError, text: text || (result.isError ? "Tool reported an error with no message." : "(empty result)") };
    } catch (error) {
      return { ok: false, text: `Tool call failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          await server.client?.close();
        } catch {
          /* already gone */
        }
        server.client = null;
      })
    );
  }
}
