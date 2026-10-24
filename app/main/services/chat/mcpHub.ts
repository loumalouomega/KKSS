/**
 * Shared owner of the single McpManager (three stdio MCP servers). Both the
 * chat agent loop (chatService.ts) and the HTTP meta server (metaServer/) call
 * ensureStarted() — whichever activates first spawns the children, the other
 * reuses them, so the three servers are never double-spawned. Mirrors the
 * shared-FlowgraphController lifecycle: constructed once in index.ts, disposed
 * on will-quit.
 */
import { app } from "electron";
import { KratosRuntime } from "./kratosRuntime";
import type { ChatServerStatus } from "../../ipc";
import { buildServerSpecs, McpManager } from "./mcpManager";
import { kratosEnvDelta, kratosRemoteHost } from "../settings/kratosEnv";
import type { UserServerStore } from "./userServerStore";

type StatusListener = (statuses: ChatServerStatus[]) => void;

export class McpHub {
  private mgr: McpManager | null = null;
  private lastStatuses: ChatServerStatus[] = [];
  private readonly listeners = new Set<StatusListener>();

  constructor(private readonly outDir: string, private readonly userServers?: UserServerStore) {
    // Edits, enable/disable, trust and project-root changes all land here; before
    // the first use there is nothing to reconcile (ensureStarted reads the store).
    userServers?.onChange(() => void this.mgr?.setUserServers(userServers.specs()));
  }

  /** Lazily spawns and connects the servers (idempotent); returns the manager. */
  ensureStarted(): McpManager {
    if (this.mgr) return this.mgr;
    // The configured servers go into the constructor, and `start()` runs in this
    // same turn: raw callers (Home, the meta server) call `ensureStarted()` and
    // straight away `callToolRaw()`, which waits on the manager's pending
    // connections. Deferring `start()` — even by a microtask, as an awaited
    // `setUserServers()` did — leaves that map empty and the call answers
    // "not connected" for a server that is about to be ready.
    this.mgr = new McpManager([...buildServerSpecs(this.outDir), ...(this.userServers?.specs() ?? [])], (statuses) => {
      this.lastStatuses = statuses;
      for (const listener of this.listeners) listener(statuses);
    }, new KratosRuntime(app.getPath("userData")), kratosEnvDelta, kratosRemoteHost);
    void this.mgr.start();
    return this.mgr;
  }

  /** The manager's Restart for any server (built-in or configured). */
  restartServer(key: string): Promise<void> {
    return this.ensureStarted().restartServer(key);
  }

  retryKratos(install = false): Promise<void> {
    return this.ensureStarted().retryKratos(install);
  }

  /** Settings ▸ Kratos ▸ Restart. Does not spawn anything if chat/MCP never started. */
  restartKratos(): Promise<void> {
    return this.mgr?.restartKratos() ?? Promise.resolve();
  }

  /** The manager if already started, else null (does not spawn). */
  manager(): McpManager | null {
    return this.mgr;
  }

  statuses(): ChatServerStatus[] {
    return this.mgr?.statuses() ?? this.lastStatuses;
  }

  onStatus(listener: StatusListener): void {
    this.listeners.add(listener);
    if (this.lastStatuses.length) listener(this.lastStatuses); // replay latest
  }

  offStatus(listener: StatusListener): void {
    this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await this.mgr?.dispose();
    this.mgr = null;
  }
}
