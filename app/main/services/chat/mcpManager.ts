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
import type { ChatImage, ChatServerStatus } from "../../ipc";
import { truncate } from "./transcript";
import { classifyStartupFailure, type KratosRuntime } from "./kratosRuntime";
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

/**
 * Caps on the image blocks forwarded to the sidebar.
 *
 * `MAX_IMAGE_BYTES` is small on purpose. It bounds the *transfer*, not the
 * decoded bitmap — PNG compresses pathologically well, and a 2 MB file can be
 * 20000x20000, i.e. well over a gigabyte of renderer memory once decoded. A low
 * cap plus the renderer attaching its <img> lazily are the two halves of that
 * bound; 512 KB is ample for what render_snapshot and compare_models emit.
 */
const IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** compare_models' own ceiling is eight labelled views. */
const MAX_IMAGES_PER_RESULT = 8;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES_TOTAL = 2 * 1024 * 1024;
/** Standard base64, no whitespace or URL-safe alphabet — this string is
 *  interpolated into a data: URL by the renderer, and an MCP server is not a
 *  trusted source. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
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

/**
 * The displayable image blocks of an MCP tool result.
 *
 * Deliberately separate from `flattenContent`, which stays byte-identical: the
 * model's view of a result must not move because the user gained a view of it.
 * A block failing any cap is dropped whole rather than truncated — half an
 * image is not a smaller image.
 */
export function extractImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  const images: ChatImage[] = [];
  let total = 0;
  for (const block of content) {
    if (images.length >= MAX_IMAGES_PER_RESULT) break;
    if (!block || typeof block !== "object") continue;
    const { type, data, mimeType } = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (type !== "image") continue;
    if (typeof data !== "string" || typeof mimeType !== "string") continue;
    if (!IMAGE_MIME_TYPES.includes(mimeType)) continue;
    if (!data || data.length > MAX_IMAGE_BYTES || !BASE64_RE.test(data)) continue;
    if (total + data.length > MAX_IMAGE_BYTES_TOTAL) break;
    total += data.length;
    images.push({ mimeType, dataBase64: data });
  }
  return images;
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
      // 0.3.0 imports mcp.server.fastmcp, removed by MCP Python 2.x.
      args: ["--with", "mcp<2", `kratos-mcp-server@${KRATOS_MCP_VERSION}`],
      env: { ...process.env } as Record<string, string>,
    },
  ];
}

interface ServerState {
  spec: ServerSpec;
  status: ChatServerStatus;
  client: Client | null;
  transport?: StdioClientTransport;
  tools: ToolDef[];
}

export class McpManager {
  private readonly servers: ServerState[];
  private started = false;
  private disposed = false;
  private readonly abort = new AbortController();
  private readonly connecting = new Map<ServerKey, Promise<void>>();
  /** uri → owning server, rebuilt on each listResources() (URIs aren't namespaced). */
  private readonly resourceOwners = new Map<string, ServerState>();

  constructor(
    specs: ServerSpec[],
    private readonly onStatus: (statuses: ChatServerStatus[]) => void,
    private readonly runtime?: Pick<KratosRuntime, "discover" | "install">
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

  /** Retry only Kratos; concurrent clicks share the same operation. */
  retryKratos(install = false): Promise<void> {
    const server = this.servers.find((s) => s.spec.key === "kratos");
    if (!server || this.disposed || server.status.state === "ready") return Promise.resolve();
    return this.connect(server, install);
  }

  private connect(server: ServerState, install = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const pending = this.connecting.get(server.spec.key);
    if (pending) return pending;
    const operation = this.connectAttempt(server, install).finally(() => this.connecting.delete(server.spec.key));
    this.connecting.set(server.spec.key, operation);
    return operation;
  }

  private async closeServer(server: ServerState): Promise<void> {
    const client = server.client;
    const transport = server.transport;
    server.client = null;
    server.transport = undefined;
    server.tools = [];
    for (const [uri, owner] of this.resourceOwners) if (owner === server) this.resourceOwners.delete(uri);
    try { await client?.close(); } catch { /* already closed */ }
    try { await transport?.close(); } catch { /* already closed */ }
  }

  private async connectAttempt(server: ServerState, install: boolean): Promise<void> {
    let stderr = "";
    const kratos = server.spec.key === "kratos";
    const status = (phase: NonNullable<ChatServerStatus["phase"]>) => {
      server.status = { key: server.spec.key, name: server.spec.name, state: "starting", phase };
      this.onStatus(this.statuses());
    };
    status(kratos ? "probing" : "preparing");
    await this.closeServer(server);
    try {
      let spec = server.spec;
      if (kratos && this.runtime) {
        if (install) {
          // A stale click must not install over an already usable runtime.
          try { await this.runtime.discover(this.abort.signal); }
          catch (error) {
            this.abort.signal.throwIfAborted();
            const failure = classifyStartupFailure(error).failure;
            if (failure !== "missing-runtime" && failure !== "runtime") throw error;
            status("installing");
            await this.runtime.install(this.abort.signal);
          }
        }
        const runtime = await this.runtime.discover(this.abort.signal);
        spec = { ...spec, command: runtime.command, args: [...runtime.args, ...spec.args], env: { ...process.env } as Record<string, string> };
      }
      this.abort.signal.throwIfAborted();
      status("preparing");
      const transport = new StdioClientTransport({
        command: spec.command, args: spec.args, env: spec.env, stderr: "pipe",
      });
      server.transport = transport;
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      const client = new Client({ name: "kkss-chat", version: "1.0.0" });
      server.client = client;
      const timeout = kratos ? 5 * 60_000 : CONNECT_TIMEOUT_MS;
      await client.connect(transport, { timeout, signal: this.abort.signal });
      const { tools } = await client.listTools(undefined, { timeout, signal: this.abort.signal });
      this.abort.signal.throwIfAborted();
      server.tools = tools.map((tool) => ({
        name: namespaceTool(server.spec.key, tool.name), description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      server.status = {
        key: server.spec.key, name: client.getServerVersion()?.name ?? server.spec.name,
        state: "ready", toolCount: server.tools.length,
      };
      client.onclose = () => {
        if (this.disposed || server.client !== client) return;
        void this.closeServer(server);
        server.status = { key: server.spec.key, name: server.spec.name, state: "unavailable",
          failure: "unknown", error: "The tool server disconnected. Retry to reconnect." };
        this.onStatus(this.statuses());
      };
    } catch (error) {
      await this.closeServer(server);
      if (this.disposed) return;
      const failure = classifyStartupFailure(error, stderr);
      server.status = { key: server.spec.key, name: server.spec.name, state: "unavailable",
        failure: failure.failure, error: truncate(failure.message, 700) };
    }
    if (!this.disposed) this.onStatus(this.statuses());
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
    return this.servers.filter((s) => s.client && s.status.state === "ready");
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
   *  server so structured content survives verbatim — `callTool` flattens it to
   *  text, forwarding image blocks separately for display only). Never throws —
   *  errors become a CallToolResult with isError. */
  async callToolRaw(namespaced: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const split = splitToolName(namespaced, this.servers.map((s) => s.spec.key));
    const server = split && this.servers.find((s) => s.spec.key === split.server);
    if (!split || !server) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${namespaced}` }] };
    if (!server.client || server.status.state !== "ready") return { isError: true, content: [{ type: "text", text: `MCP server "${server.status.name}" is unavailable: ${server.status.error ?? "not connected"}` }] };
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

  /** Routes a namespaced tool call; never throws — errors become tool results.
   *  `images` is for the sidebar only; the model sees `text`, in which
   *  `flattenContent` has already left an `[image content]` placeholder. */
  async callTool(namespaced: string, argsJson: string): Promise<{ ok: boolean; text: string; images?: ChatImage[] }> {
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
    if (!server.client || server.status.state !== "ready") return { ok: false, text: `MCP server "${server.status.name}" is unavailable: ${server.status.error ?? "not connected"}` };

    try {
      const result = await server.client.callTool({ name: split.tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      });
      const text = truncate(flattenContent(result.content), RESULT_CHARS);
      const images = extractImages(result.content);
      return {
        ok: !result.isError,
        text: text || (result.isError ? "Tool reported an error with no message." : "(empty result)"),
        ...(images.length ? { images } : {}),
      };
    } catch (error) {
      return { ok: false, text: `Tool call failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort.abort();
    await Promise.all(this.servers.map((server) => this.closeServer(server)));
    await Promise.allSettled(this.connecting.values());
  }
}
