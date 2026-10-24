import { KRATOS_MCP_VERSION } from "./kratosMcpVersion";
import { PDF_MCP_PACKAGE, PDF_MCP_VERSION } from "./pdfMcpVersion";
import { BASE64_RE, IMAGE_MIME_TYPES } from "./chatAttachments";
import { appTools, callAppTool } from "./appTools";
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
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, GetPromptResult, Prompt, ReadResourceResult, Resource } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import type { ChatImage, ChatServerStatus } from "../../ipc";
import { truncate } from "./transcript";
import { remoteUvxCommand, sshArgs } from "../cloud/providerCore/sshCore";
import { classifyStartupFailure, type KratosRuntime } from "./kratosRuntime";
import type { ToolDef } from "./providers/types";
import { PROVIDER_TOOL_NAME_RE } from "./userServers";

/** `cad`/`mesh`/`kratos`/`pdf`, or the id of a user- or project-configured server. */
export type ServerKey = string;

export interface ServerSpec {
  key: ServerKey;
  /** Display name until the server reports its own. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Absent = built-in. User/project servers are the only ones the manager's
   *  `setUserServers` may add, change or remove. */
  source?: "user" | "project";
  /** A streamable-HTTP server instead of a child process (`command`/`args`/`env`
   *  are then unused). The token is read at connect time and never kept in a status. */
  http?: { url: string; token?: () => string | undefined };
  /** Extra environment resolved at connect time (decrypted secrets), merged over `env`. */
  resolveEnv?: () => Record<string, string>;
  /** Why this server is not to be started: switched off, or a project definition
   *  the user has not trusted. */
  blocked?: "disabled" | "untrusted";
  /** Re-checked immediately before every spawn: returns a block reason, or null.
   *  How a project server's trust is verified at restart, not only at load. */
  preflight?: () => "disabled" | "untrusted" | null;
  /** Changes whenever the launch identity does; lets `setUserServers` tell an
   *  edit that needs a reconnect from an unrelated refresh. */
  revision?: string;
}

/** Pinned kratos-mcp-server release (uvx resolves this exact version). Bump on
 *  upgrade; the tool/resource/prompt surface is discovered at runtime. */
export { KRATOS_MCP_VERSION } from "./kratosMcpVersion";

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
/** compare_models' own ceiling is eight labelled views. */
const MAX_IMAGES_PER_RESULT = 8;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES_TOTAL = 2 * 1024 * 1024;
/** uvx cold-starts by downloading the package — allow a slow first connect. */
const CONNECT_TIMEOUT_MS = 60_000;
/** Meshing/simulation tools can legitimately run for minutes. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Match an explicitly requested server wait in both chat and HTTP calls. */
export function toolCallTimeout(name: string, args: Record<string, unknown>): number {
  const wait = args.wait_seconds;
  if (name === "kratos__run_simulation" && typeof wait === "number" && Number.isFinite(wait) && wait > 0) {
    const timeout = Math.max(CALL_TIMEOUT_MS, Math.ceil(wait * 1000) + 60_000);
    // Node timers overflow above this value; refusing is safer than a 1ms timeout.
    if (timeout > 2_147_483_647) throw new Error("Requested simulation wait exceeds the supported timer duration; use wait_seconds=0 and poll job_status.");
    return timeout;
  }
  return CALL_TIMEOUT_MS;
}

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

/** The server specs, resolved relative to out/ (== __dirname of main.js). */
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
      // The pinned server imports mcp.server.fastmcp, removed by MCP Python 2.x.
      args: ["--with", "mcp<2", `kratos-mcp-server@${KRATOS_MCP_VERSION}`],
      env: { ...process.env } as Record<string, string>,
    },
    {
      // Preconfigured PDF reader: lets every provider read a PDF by path, and
      // handles the files the composer's native attachment refuses (>5 MB, or a
      // provider with no PDF wire format). Launched through the same uv as Kratos.
      key: "pdf",
      name: PDF_MCP_PACKAGE,
      command: "uvx",
      args: ["--with", "mcp<2", `${PDF_MCP_PACKAGE}@${PDF_MCP_VERSION}`],
      env: { ...process.env } as Record<string, string>,
    },
  ];
}

/** Servers launched through uv: they share one runtime (and its recovery UI). */
const UV_SERVERS: readonly ServerKey[] = ["kratos", "pdf"];

interface ServerState {
  spec: ServerSpec;
  status: ChatServerStatus;
  client: Client | null;
  transport?: Transport;
  tools: ToolDef[];
}

/** A built-in server's status stays byte-identical to what it always was; only
 *  user/project servers carry their source and transport. */
function identity(spec: ServerSpec): Pick<ChatServerStatus, "key" | "name" | "source" | "transport"> {
  return spec.source
    ? { key: spec.key, name: spec.name, source: spec.source, transport: spec.http ? "http" : "stdio" }
    : { key: spec.key, name: spec.name };
}

function initialStatus(spec: ServerSpec): ChatServerStatus {
  return { ...identity(spec), state: spec.blocked ?? "starting" };
}

export class McpManager {
  private servers: ServerState[];
  private started = false;
  private disposed = false;
  private readonly abort = new AbortController();
  private readonly connecting = new Map<ServerKey, Promise<void>>();
  /** uri → owning server, rebuilt on each listResources() (URIs aren't namespaced). */
  private readonly resourceOwners = new Map<string, ServerState>();

  constructor(
    specs: ServerSpec[],
    private readonly onStatus: (statuses: ChatServerStatus[]) => void,
    private readonly runtime?: Pick<KratosRuntime, "discover" | "install">,
    /** Settings ▸ Kratos (install path, extra env) — read on every Kratos
     *  (re)start, so a change applies on the next one. A delta over the spec's env. */
    private readonly kratosEnv?: () => Record<string, string>,
    /** Settings ▸ Remote ▸ Run Kratos tools on — an ssh host, or undefined for
     *  this machine. Read on every Kratos (re)start. */
    private readonly kratosRemote?: () => string | undefined
  ) {
    this.servers = specs.map((spec) => ({ spec, status: initialStatus(spec), client: null, tools: [] }));
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
    const operation = this.connect(server, install);
    void operation.then(() => this.revivePdf());
    return operation;
  }

  /**
   * The PDF server rides the same uv, so the one Install/Retry button on the
   * Kratos banner recovers both. Fire-and-forget and idempotent: Kratos callers
   * must not wait on a second five-minute connect, and a server already ready or
   * already connecting is left alone.
   */
  private revivePdf(): void {
    const pdf = this.servers.find((s) => s.spec.key === "pdf");
    if (!pdf || this.disposed || pdf.status.state === "ready" || this.connecting.has("pdf")) return;
    void this.connect(pdf);
  }

  /**
   * Settings ▸ Kratos ▸ Restart: reconnects Kratos even when it is ready, so a
   * changed install path or environment applies now. Shares an in-flight
   * attempt like retryKratos; CAD and mesh are untouched.
   */
  restartKratos(): Promise<void> {
    const server = this.servers.find((s) => s.spec.key === "kratos");
    if (!server || this.disposed) return Promise.resolve();
    const operation = this.connect(server);
    void operation.then(() => this.revivePdf());
    return operation;
  }

  /** Reconnects any server by key (the manager's Restart). Kratos keeps its
   *  PDF-revive behaviour; a blocked server stays blocked and says why. */
  restartServer(key: ServerKey): Promise<void> {
    if (key === "kratos") return this.restartKratos();
    const server = this.servers.find((s) => s.spec.key === key);
    if (!server || this.disposed) return Promise.resolve();
    return this.connect(server);
  }

  /**
   * Replaces the user/project servers (built-ins are never touched). Servers
   * whose `revision` and `blocked` state are unchanged are left running; an edited
   * one is closed and reconnected, a removed one closed, a new one started — all
   * only once `start()` has run, so a settings change before first use stays lazy.
   */
  async setUserServers(specs: ServerSpec[]): Promise<void> {
    if (this.disposed) return;
    const builtin = this.servers.filter((s) => !s.spec.source);
    const previous = new Map(this.servers.filter((s) => s.spec.source).map((s) => [s.spec.key, s]));
    const next: ServerState[] = [];
    const reconnect: ServerState[] = [];
    const close: ServerState[] = [];
    for (const spec of specs) {
      if (!spec.source || builtin.some((b) => b.spec.key === spec.key)) continue; // never shadow a built-in
      const old = previous.get(spec.key);
      previous.delete(spec.key);
      if (old && old.spec.revision === spec.revision && old.spec.blocked === spec.blocked) {
        old.spec = spec; // refresh the lazy closures; the running connection stays
        next.push(old);
        continue;
      }
      const state: ServerState = old ?? { spec, status: initialStatus(spec), client: null, tools: [] };
      state.spec = spec;
      if (spec.blocked) { state.status = initialStatus(spec); close.push(state); }
      else { state.status = { ...identity(spec), state: "starting" }; reconnect.push(state); }
      next.push(state);
    }
    close.push(...previous.values());
    this.servers = [...builtin, ...next];
    await Promise.all(close.map((server) => this.closeServer(server)));
    this.onStatus(this.statuses());
    if (this.started) {
      await Promise.all(reconnect.map(async (server) => {
        // An attempt still running was begun against the previous definition;
        // let it settle (its finally clears the dedupe entry) and start afresh.
        await this.connecting.get(server.spec.key)?.catch(() => undefined);
        await this.connect(server);
      }));
    }
  }

  /** The server's own (un-namespaced) tool names and descriptions, for the manager. */
  toolList(key: ServerKey): Array<{ name: string; description?: string }> {
    const server = this.servers.find((s) => s.spec.key === key);
    if (!server) return [];
    const prefix = `${key}${NAMESPACE_SEPARATOR}`;
    return server.tools.map((tool) => ({ name: tool.name.slice(prefix.length), ...(tool.description ? { description: tool.description } : {}) }));
  }

  /** Looks a spec up by key (the store/service need the revision and source). */
  specFor(key: ServerKey): ServerSpec | undefined {
    return this.servers.find((s) => s.spec.key === key)?.spec;
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
    const viaUv = UV_SERVERS.includes(server.spec.key);
    const status = (phase: NonNullable<ChatServerStatus["phase"]>) => {
      server.status = { ...identity(server.spec), state: "starting", phase };
      this.onStatus(this.statuses());
    };
    // Re-checked at every spawn, so a restart cannot launch a definition whose
    // trust has lapsed since it was loaded.
    const blocked = server.spec.blocked ?? server.spec.preflight?.() ?? null;
    if (blocked) {
      await this.closeServer(server);
      server.status = { ...identity(server.spec), state: blocked };
      if (!this.disposed) this.onStatus(this.statuses());
      return;
    }
    status(kratos ? "probing" : "preparing");
    await this.closeServer(server);
    try {
      let spec = server.spec;
      const remoteHost = kratos ? this.kratosRemote?.() : undefined;
      if (remoteHost) {
        // The server runs on the other machine, through the system ssh client
        // (BatchMode: it fails rather than prompting). The local uv runtime and
        // the local Kratos env delta describe this machine, so neither applies.
        spec = {
          ...spec,
          command: "ssh",
          args: sshArgs(remoteHost, remoteUvxCommand(spec.args)),
          env: { ...process.env } as Record<string, string>,
        };
      } else if (viaUv && this.runtime) {
        // Only Kratos owns installing uv: a PDF server that fails for want of uv
        // is revived by the Kratos banner's button, not a second prompt.
        if (install && kratos) {
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
        // `bundled` is the Docker image's own kratos-mcp-server launcher, which
        // is no use for another package — the PDF spec keeps its plain uvx.
        if (kratos || !runtime.bundled) {
          spec = { ...spec, command: runtime.command, args: runtime.bundled ? runtime.args : [...runtime.args, ...spec.args], env: { ...process.env } as Record<string, string> };
        }
      }
      if (kratos && !remoteHost && this.kratosEnv) spec = { ...spec, env: { ...spec.env, ...this.kratosEnv() } };
      this.abort.signal.throwIfAborted();
      status("preparing");
      let transport: Transport;
      if (spec.http) {
        const token = spec.http.token?.();
        // `redirect: "error"`: a bearer token must never follow a redirect to another host.
        transport = new StreamableHTTPClientTransport(new URL(spec.http.url), {
          requestInit: { redirect: "error", ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
        });
      } else {
        const stdio = new StdioClientTransport({
          command: spec.command, args: spec.args, env: { ...spec.env, ...(spec.resolveEnv?.() ?? {}) }, stderr: "pipe",
        });
        stdio.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8192);
        });
        transport = stdio;
      }
      server.transport = transport;
      const client = new Client({ name: "kkss-chat", version: "1.0.0" });
      server.client = client;
      const timeout = viaUv ? 5 * 60_000 : CONNECT_TIMEOUT_MS;
      await client.connect(transport, { timeout, signal: this.abort.signal });
      const { tools } = await client.listTools(undefined, { timeout, signal: this.abort.signal });
      this.abort.signal.throwIfAborted();
      // A user server picks its own tool names; a provider rejects the whole
      // request over one it cannot take, so leave those out and say so.
      const usable = server.spec.source
        ? tools.filter((tool) => PROVIDER_TOOL_NAME_RE.test(namespaceTool(server.spec.key, tool.name)))
        : tools;
      server.tools = usable.map((tool) => ({
        name: namespaceTool(server.spec.key, tool.name), description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      const skipped = tools.length - usable.length;
      server.status = {
        ...identity(server.spec),
        // The name the user typed for their own server beats whatever it announces.
        name: server.spec.source ? server.spec.name : (client.getServerVersion()?.name ?? server.spec.name),
        state: "ready", toolCount: server.tools.length, ...(skipped ? { skippedTools: skipped } : {}),
      };
      client.onclose = () => {
        if (this.disposed || server.client !== client) return;
        void this.closeServer(server);
        server.status = { ...identity(server.spec), state: "unavailable",
          failure: "unknown", error: "The tool server disconnected. Retry to reconnect." };
        this.onStatus(this.statuses());
      };
    } catch (error) {
      await this.closeServer(server);
      if (this.disposed) return;
      const failure = classifyStartupFailure(error, stderr);
      server.status = { ...identity(server.spec), state: "unavailable",
        failure: failure.failure, error: truncate(failure.message, 700) };
    }
    if (!this.disposed) this.onStatus(this.statuses());
  }

  /** Real, namespaced tools aggregated across servers (used by the HTTP meta server). */
  tools(): ToolDef[] {
    return [...this.servers.flatMap((server) => server.tools), ...appTools()];
  }

  /** tools() plus the synthetic resource/prompt tools — for the chat provider loop. */
  chatTools(): ToolDef[] {
    return [...this.tools(), ...META_TOOLS];
  }

  toolName = (server: string, tool: string): string => namespaceTool(server, tool);

  /**
   * Ready **built-in** servers: the only ones whose resources and prompts are
   * aggregated. The `mcp__*` tools that read them are classified `read` (and the
   * HTTP meta server serves them natively), so a user server's resources would
   * be a path into an arbitrary server that skips the approval gate.
   */
  private ready(): ServerState[] {
    return this.servers.filter((s) => !s.spec.source && s.client && s.status.state === "ready");
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
    const server = split && this.servers.find((s) => s.spec.key === split.server && !s.spec.source);
    if (!split || !server?.client) throw new Error(`Unknown prompt: ${namespaced}`);
    return server.client.getPrompt({ name: split.tool, arguments: args });
  }

  /** Raw tool call that returns the untouched CallToolResult (used by the HTTP meta
   *  server so structured content survives verbatim — `callTool` flattens it to
   *  text, forwarding image blocks separately for display only). Never throws —
   *  errors become a CallToolResult with isError. */
  async callToolRaw(namespaced: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (namespaced.startsWith("app__")) return callAppTool(namespaced, args);
    const split = splitToolName(namespaced, this.servers.map((s) => s.spec.key));
    const server = split && this.servers.find((s) => s.spec.key === split.server);
    if (!split || !server) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${namespaced}` }] };
    // Home can invoke a tool immediately after lazy startup. Wait only for its
    // server, so a mesh quantity never waits for the separate Kratos runtime.
    await this.connecting.get(server.spec.key);
    if (!server.client || server.status.state !== "ready") return { isError: true, content: [{ type: "text", text: `MCP server "${server.status.name}" is unavailable: ${server.status.error ?? "not connected"}` }] };
    try {
      return (await server.client.callTool({ name: split.tool, arguments: args }, undefined, {
        timeout: toolCallTimeout(namespaced, args),
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

    if (namespaced.startsWith("app__")) {
      const result = await callAppTool(namespaced, args);
      return { ok: !result.isError, text: truncate(flattenContent(result.content), RESULT_CHARS) };
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
        timeout: toolCallTimeout(namespaced, args),
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
