/**
 * Optional HTTP MCP endpoint that re-exposes KKSS's aggregated cad+mesh+kratos
 * toolset (plus resources & prompts) to an EXTERNAL LLM client (Claude Desktop,
 * another agent). It reuses the one shared McpManager via McpHub — no second
 * spawn of the three child servers — and is the inverse of the chat sidebar
 * (which is KKSS acting as an MCP client).
 *
 * Off by default. When enabled it binds 127.0.0.1 only, requires a bearer token,
 * and validates the Host header (localhost only) — these tools touch the
 * filesystem and run simulations. Runs in the Electron main process (just an
 * http listener + the in-process hub), so there is no renderer and no CSP.
 *
 * Transport: the SDK's StreamableHTTPServerTransport in stateful mode (one
 * session per initialize), routed by the Mcp-Session-Id header. Late server
 * readiness (kratos cold start) emits list_changed to live sessions.
 */
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ChatServerStatus } from "../../ipc";
import type { McpHub } from "../chat/mcpHub";
import { buildMetaServer } from "./buildServer";

/** stateStore / secrets keys for the meta server settings. */
export const META_SERVER_KEYS = {
  enabled: "metaServerEnabled", // stateStore boolean
  port: "metaServerPort", // stateStore number
  token: "metaServerToken", // secrets.ts (safeStorage-encrypted)
} as const;

export const DEFAULT_META_SERVER_PORT = 7391;
const MCP_PATH = "/mcp";

export interface MetaServerDeps {
  hub: McpHub;
  /** App version, advertised to connecting clients. */
  version: string;
  /** Listen port, read at enable() time. */
  port(): number;
  /** Required bearer token; requests without it are rejected. */
  token(): string | undefined;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

export class MetaMcpServer {
  private httpServer: http.Server | null = null;
  private boundPort = 0;
  private readonly sessions = new Map<string, Session>();
  private readonly onStatus = (statuses: ChatServerStatus[]) => this.broadcastListChanged(statuses);

  constructor(private readonly deps: MetaServerDeps) {}

  isRunning(): boolean {
    return this.httpServer !== null;
  }

  /** `http://127.0.0.1:<port>/mcp` when running, else null. */
  address(): string | null {
    return this.httpServer ? `http://127.0.0.1:${this.boundPort}${MCP_PATH}` : null;
  }

  /** Starts the listener (idempotent). Rejects if the port is unavailable. */
  async enable(): Promise<void> {
    if (this.httpServer) return;
    const port = this.deps.port();
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    const address = server.address();
    this.httpServer = server;
    this.boundPort = typeof address === "object" && address ? address.port : port;
    this.deps.hub.onStatus(this.onStatus);
  }

  /** Stops the listener and tears down all sessions (idempotent). */
  async disable(): Promise<void> {
    if (!this.httpServer) return;
    this.deps.hub.offStatus(this.onStatus);
    for (const { transport } of this.sessions.values()) {
      try {
        await transport.close();
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    this.httpServer = null;
    this.boundPort = 0;
  }

  async dispose(): Promise<void> {
    await this.disable();
  }

  /** Notifies live sessions that the aggregated tool/resource/prompt lists changed. */
  private broadcastListChanged(_statuses: ChatServerStatus[]): void {
    for (const { server } of this.sessions.values()) {
      void server.sendToolListChanged().catch(() => {});
      void server.sendResourceListChanged().catch(() => {});
      void server.sendPromptListChanged().catch(() => {});
    }
  }

  private reject(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const expected = this.deps.token();
    if (!expected) return false; // never serve without a configured token
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${expected}`;
  }

  /** Host must be localhost on our port — defeats DNS-rebinding from a browser. */
  private hostAllowed(req: http.IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${this.boundPort}` || host === `localhost:${this.boundPort}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = req.url ?? "";
      if (!url.startsWith(MCP_PATH)) return this.reject(res, 404, "Not found");
      if (!this.hostAllowed(req)) return this.reject(res, 403, "Forbidden host");
      if (!this.authorized(req)) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }

      const body = req.method === "POST" ? await readJson(req) : undefined;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const existing = sessionId ? this.sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "POST" && !sessionId && isInitializeRequest(body)) {
        await this.openSession(req, res, body);
        return;
      }
      this.reject(res, 400, "Bad Request: no valid session");
    } catch (error) {
      if (!res.headersSent) this.reject(res, 500, error instanceof Error ? error.message : String(error));
    }
  }

  private async openSession(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
    const server = buildMetaServer(this.deps.hub, this.deps.version);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string): void => {
        this.sessions.set(sid, { transport, server });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

/** Reads and JSON-parses a request body (returns undefined on empty/invalid). */
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}
