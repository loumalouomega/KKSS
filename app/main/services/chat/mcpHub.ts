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

  /**
   * `only` restricts the built-in servers that start (the headless study runner needs cad and mesh,
   * not the uv-launched Kratos and PDF servers, which would reach for the network).
   */
  constructor(private readonly outDir: string, private readonly userServers?: UserServerStore, private readonly only?: readonly string[]) {
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
    this.mgr = new McpManager([...buildServerSpecs(this.outDir).filter((s) => !this.only || this.only.includes(s.key)), ...(this.userServers?.specs() ?? [])], (statuses) => {
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

/**
 * Resolves when every named server is ready; rejects as soon as one is unavailable or after `timeoutMs`.
 * Used before a queue starts tasks that go through the CAD and mesh servers.
 */
export function waitForServers(
  hub: Pick<McpHub, "ensureStarted" | "statuses" | "onStatus" | "offStatus">,
  keys: readonly string[],
  timeoutMs = 60_000,
): Promise<void> {
  hub.ensureStarted();
  return new Promise<void>((resolve, reject) => {
    const listener = (statuses: ChatServerStatus[]): void => {
      const required = statuses.filter((s) => keys.includes(s.key));
      const down = required.filter((s) => s.state === "unavailable");
      if (down.length) finish(new Error(down.map((s) => `${s.name}: ${s.error ?? "unavailable"}`).join("; ")));
      else if (required.length === keys.length && required.every((s) => s.state === "ready")) finish();
    };
    const timer = setTimeout(() => finish(new Error(`${keys.map((k) => k.toUpperCase()).join(" and ")} tool servers did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      hub.offStatus(listener);
      if (error) reject(error); else resolve();
    };
    hub.onStatus(listener);
    listener(hub.statuses());
  });
}
