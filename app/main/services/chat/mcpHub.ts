/**
 * Shared owner of the single McpManager (three stdio MCP servers). Both the
 * chat agent loop (chatService.ts) and the HTTP meta server (metaServer/) call
 * ensureStarted() — whichever activates first spawns the children, the other
 * reuses them, so the three servers are never double-spawned. Mirrors the
 * shared-FlowgraphController lifecycle: constructed once in index.ts, disposed
 * on will-quit.
 */
import type { ChatServerStatus } from "../../ipc";
import { buildServerSpecs, McpManager } from "./mcpManager";

type StatusListener = (statuses: ChatServerStatus[]) => void;

export class McpHub {
  private mgr: McpManager | null = null;
  private lastStatuses: ChatServerStatus[] = [];
  private readonly listeners = new Set<StatusListener>();

  constructor(private readonly outDir: string) {}

  /** Lazily spawns and connects the servers (idempotent); returns the manager. */
  ensureStarted(): McpManager {
    if (this.mgr) return this.mgr;
    this.mgr = new McpManager(buildServerSpecs(this.outDir), (statuses) => {
      this.lastStatuses = statuses;
      for (const listener of this.listeners) listener(statuses);
    });
    void this.mgr.start();
    return this.mgr;
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
