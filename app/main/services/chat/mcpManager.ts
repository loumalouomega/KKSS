/**
 * MCP client manager for the chat agent: spawns the three stdio MCP servers
 * (cad = cad-preview bundle, mesh = kratos-mdpa bundle, kratos =
 * kratos-mcp-server from PyPI via uvx), aggregates their tools under
 * namespaced names ("cad__load_model") and routes tool calls back.
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

const NAMESPACE_SEPARATOR = "__";
/** Cap on tool-result text handed back to the model. */
export const RESULT_CHARS = 50_000;
/** uvx cold-starts by downloading the package — allow a slow first connect. */
const CONNECT_TIMEOUT_MS = 60_000;
/** Meshing/simulation tools can legitimately run for minutes. */
const CALL_TIMEOUT_MS = 10 * 60_000;

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
      args: ["kratos-mcp-server"],
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

  tools(): ToolDef[] {
    return this.servers.flatMap((server) => server.tools);
  }

  toolName = (server: string, tool: string): string => namespaceTool(server as ServerKey, tool);

  /** Routes a namespaced tool call; never throws — errors become tool results. */
  async callTool(namespaced: string, argsJson: string): Promise<{ ok: boolean; text: string }> {
    const split = splitToolName(
      namespaced,
      this.servers.map((s) => s.spec.key)
    );
    const server = split && this.servers.find((s) => s.spec.key === split.server);
    if (!split || !server) return { ok: false, text: `Unknown tool: ${namespaced}` };
    if (!server.client) return { ok: false, text: `MCP server "${server.status.name}" is unavailable: ${server.status.error ?? "not connected"}` };

    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, text: `Invalid JSON arguments for ${namespaced}` };
    }
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
