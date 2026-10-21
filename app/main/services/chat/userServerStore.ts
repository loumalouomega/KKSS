/**
 * Glue for user- and project-configured MCP servers: reads and writes the state
 * store, the encrypted secrets and the project's `.kkss/assistant/mcp.json`, and
 * turns them into `ServerSpec`s for `McpManager` plus rows for the sidebar.
 *
 * Electron-free on purpose — everything environmental (state, secrets, the
 * explicit project root) arrives through `StoreDeps`, so the whole thing is
 * unit-tested against a temp directory. The decisions live in `userServers.ts`
 * and `folderTrustCore.ts`.
 *
 * Load-bearing rules (also in CLAUDE.md):
 * - A project file is untrusted input until the user trusts its *hash*; the
 *   check is repeated by `preflight()` immediately before every spawn.
 * - Project definitions carry no secret values and no tool marks.
 * - Marks are bound to a launch fingerprint and live only in the user's state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChatMcpMark, ChatMcpProject, ChatMcpServerInput, ChatMcpServerRow, ChatServerStatus,
} from "../../ipc";
import type { ToolClass } from "./toolPolicy";
import { readAssistantTree } from "./assistantFiles";
import type { ServerSpec } from "./mcpManager";
import {
  ASSISTANT_DIR, hashDefinitions, parseTrustStore, shortHash, trustState,
  withTrust, withoutTrust, type TrustState,
} from "./folderTrustCore";
import {
  MAX_DEFINITION_BYTES, MAX_SERVERS, idProblem, isReservedId, launchFingerprint, makeClassifier,
  marksFor, parseDefinitionText, parseMarks, parseServer, parseServerList, pruneMarks, serializeServers,
  urlProblem, withMark, type ServerDef, type ToolMark,
} from "./userServers";

export const MCP_SERVERS_KEY = "assistantMcpServers";
export const MCP_MARKS_KEY = "assistantMcpToolMarks";
export const MCP_TRUST_KEY = "assistantFolderTrust";

const envSecretKey = (id: string, name: string) => `assistantMcp.${id}.env.${name}`;
const tokenSecretKey = (id: string) => `assistantMcp.${id}.token`;

export interface StoreDeps {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  isManaged(key: string): boolean;
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): Promise<void>;
  /** `projectRoot.explicit()` — never the inferred root. */
  explicitRoot(): string | undefined;
  /** The host environment, for project passthrough of named variables. */
  env(): NodeJS.ProcessEnv;
  now(): number;
}

export type SaveResult = { ok: true } | { ok: false; code: "invalid" | "managed" | "reserved" | "duplicate" | "unknown" | "failed"; detail?: string };

export interface ProjectLoad {
  root?: string;
  realRoot?: string;
  state: ChatMcpProject["state"];
  hash: string | null;
  servers: ServerDef[];
  errors: string[];
  /** Every definition file read (relative name → text); the trust hash covers all of it. */
  files: Record<string, string>;
}

export class UserServerStore {
  private readonly listeners = new Set<() => void>();
  /** Bumped when a server's stored secrets change, so the manager reconnects it. */
  private readonly secretEpoch = new Map<string, number>();
  private project: ProjectLoad = { state: "none", hash: null, servers: [], errors: [], files: {} };

  constructor(private readonly deps: StoreDeps) {
    this.project = this.loadProject();
  }

  onChange(listener: () => void): void { this.listeners.add(listener); }
  private emit(): void { for (const l of [...this.listeners]) l(); }

  /** The store is locked by a managed deployment: edits are refused, not ignored. */
  managed(): boolean {
    return this.deps.isManaged(MCP_SERVERS_KEY) || this.deps.isManaged(MCP_MARKS_KEY) || this.deps.isManaged(MCP_TRUST_KEY);
  }

  // ---------------------------------------------------------------- reading

  userServers(): ServerDef[] {
    const raw = this.deps.get<unknown>(MCP_SERVERS_KEY);
    return parseServerList(raw, "user").servers;
  }

  /** Project servers that may be shown: a user id always wins a collision. */
  private projectServers(): ServerDef[] {
    const taken = new Set(this.userServers().map((s) => s.id));
    return this.project.servers.filter((s) => !taken.has(s.id));
  }

  private defFor(id: string): ServerDef | undefined {
    return this.userServers().find((s) => s.id === id) ?? this.projectServers().find((s) => s.id === id);
  }

  loadProject(): ProjectLoad {
    const root = this.deps.explicitRoot();
    const none: ProjectLoad = { state: "none", hash: null, servers: [], errors: [], files: {} };
    if (!root) return none;
    let realRoot: string;
    try { realRoot = fs.realpathSync(root); } catch { return { ...none, root }; }
    const read = readAssistantTree(path.join(realRoot, ...ASSISTANT_DIR.split("/")), realRoot);
    if (read.error) return { root, realRoot, state: "invalid", hash: null, servers: [], errors: [read.error], files: {} };
    const files = read.files;
    const hash = hashDefinitions(files);
    const parsed = files["mcp.json"] !== undefined ? parseDefinitionText(files["mcp.json"], "project") : { servers: [], errors: [] };
    const state: TrustState = trustState(parseTrustStore(this.deps.get<unknown>(MCP_TRUST_KEY)), realRoot, hash);
    return { root, realRoot, state, hash, servers: parsed.servers, errors: parsed.errors, files };
  }

  /**
   * The project's definition files, but **only while the folder is trusted** —
   * read fresh from disk and verified against the recorded hash on every call.
   * Instructions, skills and prompt templates change what the model is told, so
   * an edit after trust drops them at once (and refreshes the cached state so
   * the manager shows "changed") instead of waiting for a reload.
   */
  trustedProjectFiles(): Record<string, string> {
    const fresh = this.loadProject();
    if (fresh.state !== this.project.state || fresh.hash !== this.project.hash) {
      this.project = fresh;
      this.emit();
    }
    return fresh.state === "trusted" ? fresh.files : {};
  }

  /** Re-reads the project folder (explicit root changed, or the user asked). */
  reloadProject(): void {
    this.project = this.loadProject();
    this.emit();
  }

  projectInfo(): ChatMcpProject {
    const p = this.project;
    return {
      ...(p.root ? { root: p.root } : {}),
      state: p.state,
      ...(p.hash ? { shortHash: shortHash(p.hash) } : {}),
      errors: p.errors,
    };
  }

  // ------------------------------------------------------------ manager specs

  private revisionOf(def: ServerDef): string {
    return `${launchFingerprint(def)}:${def.transport.type === "stdio" ? def.transport.env.join(",") : def.transport.tokenEnv ?? ""}:${this.secretEpoch.get(def.id) ?? 0}`;
  }

  specs(): ServerSpec[] {
    const out: ServerSpec[] = [];
    for (const def of this.userServers()) out.push(this.specOf(def, "user"));
    for (const def of this.projectServers()) out.push(this.specOf(def, "project"));
    return out;
  }

  private specOf(def: ServerDef, source: "user" | "project"): ServerSpec {
    const t = def.transport;
    const project = source === "project";
    const revision = this.revisionOf(def);
    // Project servers are blocked until the folder is trusted, then follow their
    // own `enabled`; the trust is re-verified by `preflight` at every spawn.
    const blocked: ServerSpec["blocked"] = project && this.project.state !== "trusted" ? "untrusted" : def.enabled ? undefined : "disabled";
    const preflight = project ? () => this.projectStillTrusted(def.id, revision) : undefined;
    // `env` stays empty: the SDK adds its minimal default environment (PATH, HOME…)
    // and nothing else — a user server sees only the variables named for it.
    const base: ServerSpec = { key: def.id, name: def.name, source, command: "", args: [], env: {}, revision, ...(blocked ? { blocked } : {}), ...(preflight ? { preflight } : {}) };
    if (t.type === "http") {
      const token = project
        ? () => (t.tokenEnv ? this.deps.env()[t.tokenEnv] : undefined)
        : () => this.deps.getSecret(tokenSecretKey(def.id));
      return { ...base, http: { url: t.url, token } };
    }
    const resolveEnv = () => {
      const env: Record<string, string> = {};
      for (const name of t.env) {
        const value = project ? this.deps.env()[name] : this.deps.getSecret(envSecretKey(def.id, name));
        if (value !== undefined) env[name] = value;
      }
      return env;
    };
    return { ...base, command: t.command, args: t.args, resolveEnv };
  }

  /** Fresh from disk, not the cache: this is the check that gates a spawn. */
  private projectStillTrusted(id: string, revision: string): "untrusted" | null {
    const fresh = this.loadProject();
    const def = fresh.servers.find((s) => s.id === id);
    if (fresh.state !== "trusted" || !def || this.revisionOf(def) !== revision) {
      this.project = fresh;
      this.emit();
      return "untrusted";
    }
    return null;
  }

  // -------------------------------------------------------------------- rows

  rows(statuses: readonly ChatServerStatus[]): ChatMcpServerRow[] {
    const byKey = new Map(statuses.map((s) => [s.key, s]));
    const rows: ChatMcpServerRow[] = [];
    for (const s of statuses) {
      if (s.source) continue;
      rows.push({
        id: s.key, name: s.name, source: "builtin", transport: "stdio", state: s.state, enabled: true,
        ...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {}),
        ...(s.error ? { error: s.error } : {}),
        editable: false,
      });
    }
    const add = (def: ServerDef, source: "user" | "project") => {
      const status = byKey.get(def.id);
      const t = def.transport;
      const state: ChatServerStatus["state"] = status?.state ?? (def.enabled ? "starting" : "disabled");
      rows.push({
        id: def.id, name: def.name, source, transport: t.type, state, enabled: def.enabled,
        ...(status?.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
        ...(status?.skippedTools ? { skippedTools: status.skippedTools } : {}),
        ...(status?.error ? { error: status.error } : {}),
        editable: source === "user",
        ...(t.type === "stdio"
          ? { command: t.command, args: t.args, envNames: t.env }
          : { url: t.url, ...(source === "user" ? { tokenSet: this.deps.getSecret(tokenSecretKey(def.id)) !== undefined } : t.tokenEnv ? { tokenEnv: t.tokenEnv } : {}) }),
      });
    };
    for (const def of this.userServers()) add(def, "user");
    for (const def of this.projectServers()) add(def, "project");
    return rows;
  }

  // ------------------------------------------------------------------- marks

  private marks() { return parseMarks(this.deps.get<unknown>(MCP_MARKS_KEY)); }

  marksForServer(id: string): Record<string, ToolMark> {
    const def = this.defFor(id);
    return def ? marksFor(this.marks(), id, launchFingerprint(def)) : {};
  }

  markOf(id: string, tool: string): ChatMcpMark {
    return this.marksForServer(id)[tool] ?? "unknown";
  }

  /** The gate's classifier: built-ins from the reviewed table, user tools from marks. */
  classifier(): (namespaced: string) => ToolClass {
    return makeClassifier((id) => this.marksForServer(id));
  }

  async setMark(id: string, tool: string, mark: ChatMcpMark): Promise<SaveResult> {
    if (this.managed()) return { ok: false, code: "managed" };
    const def = this.defFor(id);
    if (!def) return { ok: false, code: "unknown" };
    if (!tool || tool.length > 128) return { ok: false, code: "invalid" };
    const next = withMark(this.marks(), id, launchFingerprint(def), tool, mark === "unknown" ? null : mark);
    await this.deps.update(MCP_MARKS_KEY, next);
    this.emit();
    return { ok: true };
  }

  private async pruneStoredMarks(): Promise<void> {
    const live: Record<string, string> = {};
    for (const def of [...this.userServers(), ...this.projectServers()]) live[def.id] = launchFingerprint(def);
    const marks = this.marks();
    const pruned = pruneMarks(marks, live);
    // Only user servers' marks are dropped when a project is closed or swapped:
    // keep an unloaded project's marks out of the store rather than guessing.
    if (Object.keys(pruned).length !== Object.keys(marks).length) await this.deps.update(MCP_MARKS_KEY, Object.keys(pruned).length ? pruned : undefined);
  }

  // --------------------------------------------------------------- mutations

  async save(input: ChatMcpServerInput): Promise<SaveResult> {
    if (this.managed()) return { ok: false, code: "managed" };
    if (!input || typeof input !== "object") return { ok: false, code: "invalid" };
    const problem = idProblem(input.id);
    if (problem) return { ok: false, code: isReservedId(String(input.id)) ? "reserved" : "invalid", detail: problem };
    const existing = this.userServers();
    const current = existing.find((s) => s.id === input.id);
    if (!current && existing.length >= MAX_SERVERS) return { ok: false, code: "invalid", detail: `at most ${MAX_SERVERS} servers` };
    const stdio = input.transport === "stdio";
    if (!stdio && input.transport !== "http") return { ok: false, code: "invalid", detail: "transport must be stdio or http" };

    // The bearer-token rule needs to know whether a token will exist after this save.
    const tokenAfter = input.token === undefined ? this.deps.getSecret(tokenSecretKey(input.id)) !== undefined : input.token !== "";
    const raw: Record<string, unknown> = {
      id: input.id, name: input.name, enabled: input.enabled ?? current?.enabled ?? true,
      ...(stdio
        ? { command: input.command, args: input.args ?? [], env: (input.env ?? []).map((e) => e?.name) }
        : { url: input.url }),
    };
    const errors: string[] = [];
    const def = parseServer(raw, "user", errors);
    if (!def) return { ok: false, code: "invalid", detail: errors.join("; ") };
    if (def.transport.type === "http" && tokenAfter) {
      const tokenProblem = urlProblem(def.transport.url, true);
      if (tokenProblem) return { ok: false, code: "invalid", detail: tokenProblem };
    }

    // Secrets first: a server is never stored pointing at a value that failed to save.
    let secretsChanged = false;
    try {
      if (def.transport.type === "stdio") {
        const keep = new Set(def.transport.env);
        for (const e of input.env ?? []) {
          if (typeof e.value === "string") { await this.deps.setSecret(envSecretKey(def.id, e.name), e.value); secretsChanged = true; }
        }
        // Variables dropped from the list lose their stored value too.
        const previous = current?.transport.type === "stdio" ? current.transport.env : [];
        for (const name of previous) if (!keep.has(name)) { await this.deps.setSecret(envSecretKey(def.id, name), ""); secretsChanged = true; }
        if (current?.transport.type === "http") { await this.deps.setSecret(tokenSecretKey(def.id), ""); secretsChanged = true; }
      } else {
        if (typeof input.token === "string") { await this.deps.setSecret(tokenSecretKey(def.id), input.token); secretsChanged = true; }
        if (current?.transport.type === "stdio") {
          for (const name of current.transport.env) await this.deps.setSecret(envSecretKey(def.id, name), "");
          secretsChanged = true;
        }
      }
    } catch (error) {
      return { ok: false, code: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (secretsChanged) this.secretEpoch.set(def.id, (this.secretEpoch.get(def.id) ?? 0) + 1);

    const next = current ? existing.map((s) => (s.id === def.id ? def : s)) : [...existing, def];
    await this.deps.update(MCP_SERVERS_KEY, serializeServers(next));
    await this.pruneStoredMarks();
    this.emit();
    return { ok: true };
  }

  async remove(id: string): Promise<SaveResult> {
    if (this.managed()) return { ok: false, code: "managed" };
    const existing = this.userServers();
    const def = existing.find((s) => s.id === id);
    if (!def) return { ok: false, code: "unknown" };
    if (def.transport.type === "stdio") for (const name of def.transport.env) await this.deps.setSecret(envSecretKey(id, name), "");
    else await this.deps.setSecret(tokenSecretKey(id), "");
    this.secretEpoch.delete(id);
    const next = existing.filter((s) => s.id !== id);
    await this.deps.update(MCP_SERVERS_KEY, next.length ? serializeServers(next) : undefined);
    await this.pruneStoredMarks();
    this.emit();
    return { ok: true };
  }

  async setEnabled(id: string, enabled: boolean): Promise<SaveResult> {
    if (this.managed()) return { ok: false, code: "managed" };
    const existing = this.userServers();
    const def = existing.find((s) => s.id === id);
    if (!def) return { ok: false, code: "unknown" };
    await this.deps.update(MCP_SERVERS_KEY, serializeServers(existing.map((s) => (s.id === id ? { ...s, enabled } : s))));
    this.emit();
    return { ok: true };
  }

  /** User click only. Trusts exactly the hash on disk right now. */
  async trustProject(): Promise<SaveResult> {
    if (this.managed()) return { ok: false, code: "managed" };
    const fresh = this.loadProject();
    this.project = fresh;
    if (!fresh.realRoot || !fresh.hash || fresh.state === "invalid") { this.emit(); return { ok: false, code: "invalid", detail: fresh.errors.join("; ") || undefined }; }
    const store = withTrust(parseTrustStore(this.deps.get<unknown>(MCP_TRUST_KEY)), fresh.realRoot, fresh.hash, this.deps.now());
    await this.deps.update(MCP_TRUST_KEY, store);
    this.project = this.loadProject();
    this.emit();
    return { ok: true };
  }

  async revokeProject(): Promise<SaveResult> {
    if (this.managed()) return { ok: false, code: "managed" };
    const fresh = this.loadProject();
    if (fresh.realRoot) {
      const store = withoutTrust(parseTrustStore(this.deps.get<unknown>(MCP_TRUST_KEY)), fresh.realRoot);
      await this.deps.update(MCP_TRUST_KEY, Object.keys(store).length ? store : undefined);
    }
    this.project = this.loadProject();
    this.emit();
    return { ok: true };
  }
}
