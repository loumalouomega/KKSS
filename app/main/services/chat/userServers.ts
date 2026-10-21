/**
 * User- and project-configured MCP servers: definitions, validation, tool marks.
 *
 * Pure (no Electron, no stateStore, no filesystem) so every rule is unit-tested
 * — the transcriptStoreCore / secretCodec split. The glue that reads the store,
 * the secrets and the project file is `userServerStore.ts`.
 *
 * Invariants worth keeping in view when changing this file:
 * - A definition holds **names only**. Env values and bearer tokens live in
 *   `chat/secrets.ts`; a project file can name host environment variables to
 *   pass through but can never carry a value.
 * - Ids are lowercase letters, digits and hyphens: `splitToolName` splits at the
 *   first `__`, so an id containing `_` could not round-trip. The built-in
 *   prefixes are reserved because classification is keyed by the *full* name —
 *   a user server called `cad` exposing `list_layers` would otherwise inherit
 *   the built-in `cad__list_layers` read row and skip the prompt.
 * - A tool mark is the user's own decision, bound to the launch fingerprint it
 *   was made against. It is never read from a project file, and never inferred
 *   from a tool's name or annotations (the SDK says a client must not).
 */
import { createHash } from "node:crypto";
import { classifyTool, type ToolClass } from "./toolPolicy";

/** Built-in server ids plus the two synthetic namespaces (`app__*`, `mcp__*`). */
export const RESERVED_SERVER_IDS: readonly string[] = ["cad", "mesh", "kratos", "pdf", "app", "mcp"];
export const SERVER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A tool name as every provider accepts it (Anthropic's is the strictest). */
export const PROVIDER_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const MAX_SERVERS = 32;
export const MAX_ARGS = 64;
export const MAX_ENV = 32;
/** A definition file is a handful of lines; anything larger is not one. */
export const MAX_DEFINITION_BYTES = 64 * 1024;

export type ServerSource = "user" | "project";

export type TransportDef =
  | {
      type: "stdio";
      command: string;
      args: string[];
      /** Variable names. User servers: values come from the secret store.
       *  Project servers: values come from the host process environment. */
      env: string[];
    }
  | {
      type: "http";
      url: string;
      /** Project servers only: the host environment variable holding the bearer token. */
      tokenEnv?: string;
    };

export interface ServerDef {
  id: string;
  name: string;
  enabled: boolean;
  transport: TransportDef;
}

export interface ParsedServers {
  servers: ServerDef[];
  errors: string[];
}

export function isReservedId(id: string): boolean {
  return RESERVED_SERVER_IDS.includes(id);
}

/** Why `id` cannot name a server, or null. */
export function idProblem(id: unknown): string | null {
  if (typeof id !== "string" || !id) return "id is required";
  if (!SERVER_ID_RE.test(id)) return `id "${id}" must be 1-32 lowercase letters, digits or hyphens, starting with a letter`;
  if (isReservedId(id)) return `id "${id}" is reserved`;
  return null;
}

/** http(s) only; a bearer token never travels in cleartext off the loopback. */
export function urlProblem(raw: unknown, hasToken: boolean): string | null {
  if (typeof raw !== "string" || !raw) return "url is required";
  let url: URL;
  try { url = new URL(raw); } catch { return "url is not a valid URL"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "url must be http or https";
  if (url.username || url.password) return "url must not embed credentials";
  if (hasToken && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "a bearer token needs https unless the server is on this machine";
  }
  return null;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function stringList(raw: unknown, what: string, max: number, errors: string[], label: string): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    errors.push(`${label}: ${what} must be a list of strings`);
    return null;
  }
  if (raw.length > max) {
    errors.push(`${label}: at most ${max} ${what}`);
    return null;
  }
  return raw as string[];
}

/**
 * Validates one definition object. Never throws; problems are pushed to `errors`
 * (prefixed with the id, so a file with several servers says which is wrong) and
 * the entry is dropped — a half-valid definition must not launch.
 */
export function parseServer(raw: unknown, source: ServerSource, errors: string[]): ServerDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("a server entry must be an object");
    return null;
  }
  const o = raw as Record<string, unknown>;
  const bad = idProblem(o.id);
  if (bad) { errors.push(bad); return null; }
  const id = o.id as string;
  const label = id;
  const hasCommand = o.command !== undefined;
  const hasUrl = o.url !== undefined;
  if (hasCommand === hasUrl) { errors.push(`${label}: give either "command" (stdio) or "url" (http)`); return null; }
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 80) : id;
  const enabled = o.enabled === false ? false : true;

  if (hasCommand) {
    if (typeof o.command !== "string" || !o.command.trim()) { errors.push(`${label}: command must be a non-empty string`); return null; }
    if (o.command.includes("\0")) { errors.push(`${label}: command contains a NUL byte`); return null; }
    const args = stringList(o.args, "arguments", MAX_ARGS, errors, label);
    const env = stringList(o.env, "environment variable names", MAX_ENV, errors, label);
    if (!args || !env) return null;
    for (const name of env) {
      if (!ENV_NAME_RE.test(name)) { errors.push(`${label}: "${name}" is not a valid environment variable name`); return null; }
    }
    if (new Set(env).size !== env.length) { errors.push(`${label}: duplicate environment variable name`); return null; }
    if (o.tokenEnv !== undefined) { errors.push(`${label}: tokenEnv applies to http servers only`); return null; }
    return { id, name, enabled, transport: { type: "stdio", command: o.command.trim(), args, env } };
  }

  if (o.args !== undefined || o.env !== undefined) { errors.push(`${label}: args and env apply to stdio servers only`); return null; }
  let tokenEnv: string | undefined;
  if (o.tokenEnv !== undefined) {
    if (source !== "project") { errors.push(`${label}: tokenEnv is only for project definitions (user tokens are stored encrypted)`); return null; }
    if (typeof o.tokenEnv !== "string" || !ENV_NAME_RE.test(o.tokenEnv)) { errors.push(`${label}: tokenEnv must be an environment variable name`); return null; }
    tokenEnv = o.tokenEnv;
  }
  const problem = urlProblem(o.url, tokenEnv !== undefined);
  if (problem) { errors.push(`${label}: ${problem}`); return null; }
  return { id, name, enabled, transport: { type: "http", url: o.url as string, ...(tokenEnv ? { tokenEnv } : {}) } };
}

/** Parses the `servers` array of a stored list or a project file's JSON text. */
export function parseServerList(raw: unknown, source: ServerSource): ParsedServers {
  const errors: string[] = [];
  const servers: ServerDef[] = [];
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { servers?: unknown }).servers : undefined;
  if (!Array.isArray(list)) {
    if (raw !== undefined) errors.push('expected {"servers": [...]}');
    return { servers, errors };
  }
  const seen = new Set<string>();
  for (const entry of list) {
    if (servers.length >= MAX_SERVERS) { errors.push(`at most ${MAX_SERVERS} servers`); break; }
    const def = parseServer(entry, source, errors);
    if (!def) continue;
    if (seen.has(def.id)) { errors.push(`${def.id}: duplicate id`); continue; }
    seen.add(def.id);
    servers.push(def);
  }
  return { servers, errors };
}

/** Parses a project file's text (size-capped, JSON errors reported not thrown). */
export function parseDefinitionText(text: string, source: ServerSource): ParsedServers {
  if (Buffer.byteLength(text, "utf8") > MAX_DEFINITION_BYTES) {
    return { servers: [], errors: [`definition file is larger than ${MAX_DEFINITION_BYTES / 1024} KB`] };
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch (error) {
    return { servers: [], errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return parseServerList(json, source);
}

/** The stored form of the user's list (names and flags only). */
export function serializeServers(servers: readonly ServerDef[]): Array<Record<string, unknown>> {
  return servers.map((s) => {
    const base: Record<string, unknown> = { id: s.id, name: s.name, ...(s.enabled ? {} : { enabled: false }) };
    return s.transport.type === "stdio"
      ? { ...base, command: s.transport.command, args: s.transport.args, env: s.transport.env }
      : { ...base, url: s.transport.url, ...(s.transport.tokenEnv ? { tokenEnv: s.transport.tokenEnv } : {}) };
  });
}

/**
 * Identity of *what gets launched*. Marks and project trust are bound to it: a
 * swapped binary, argument list or URL must not inherit the old "read".
 */
export function launchFingerprint(def: ServerDef): string {
  const t = def.transport;
  const basis = t.type === "stdio" ? ["stdio", t.command, t.args] : ["http", t.url];
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

// ---------------------------------------------------------------------------
// Tool marks
// ---------------------------------------------------------------------------

export type ToolMark = "read" | "write";
export type ServerMarks = { fingerprint: string; tools: Record<string, ToolMark> };
export type MarkStore = Record<string, ServerMarks>;

/** Defensive read of the stored marks: anything malformed is dropped, never trusted. */
export function parseMarks(raw: unknown): MarkStore {
  const out: MarkStore = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (idProblem(id) || !value || typeof value !== "object") continue;
    const { fingerprint, tools } = value as { fingerprint?: unknown; tools?: unknown };
    if (typeof fingerprint !== "string" || !tools || typeof tools !== "object" || Array.isArray(tools)) continue;
    const clean: Record<string, ToolMark> = {};
    for (const [tool, mark] of Object.entries(tools as Record<string, unknown>)) {
      if (mark === "read" || mark === "write") clean[tool] = mark;
    }
    if (Object.keys(clean).length) out[id] = { fingerprint, tools: clean };
  }
  return out;
}

/** The marks that apply to this server *as currently defined*. */
export function marksFor(store: MarkStore, id: string, fingerprint: string): Record<string, ToolMark> {
  const entry = store[id];
  return entry && entry.fingerprint === fingerprint ? entry.tools : {};
}

/** Sets or clears (`mark === null`) one mark; a stale fingerprint is replaced, not merged. */
export function withMark(store: MarkStore, id: string, fingerprint: string, tool: string, mark: ToolMark | null): MarkStore {
  const current = marksFor(store, id, fingerprint);
  const tools = { ...current };
  if (mark === null) delete tools[tool]; else tools[tool] = mark;
  const next: MarkStore = { ...store };
  if (Object.keys(tools).length) next[id] = { fingerprint, tools };
  else delete next[id];
  return next;
}

/** Drops marks for servers that no longer exist or whose launch identity changed. */
export function pruneMarks(store: MarkStore, live: Readonly<Record<string, string>>): MarkStore {
  const next: MarkStore = {};
  for (const [id, entry] of Object.entries(store)) {
    if (live[id] === entry.fingerprint) next[id] = entry;
  }
  return next;
}

/**
 * The gate's classifier. Built-in and synthetic namespaces resolve through the
 * reviewed table (unchanged); every other prefix is a user/project server whose
 * tools are `unknown` (⇒ ask) unless the user marked them.
 *
 * `marks(id)` returns the marks valid for the server as currently defined.
 */
export function makeClassifier(marks: (id: string) => Readonly<Record<string, ToolMark>> | undefined): (namespaced: string) => ToolClass {
  return (namespaced) => {
    const index = namespaced.indexOf("__");
    const server = index > 0 ? namespaced.slice(0, index) : "";
    if (!server || isReservedId(server)) return classifyTool(namespaced);
    return marks(server)?.[namespaced.slice(index + 2)] ?? "unknown";
  };
}

/** True for a tool of a non-built-in server (what `unclassifiedTools` should skip). */
export function isUserTool(namespaced: string): boolean {
  const index = namespaced.indexOf("__");
  return index > 0 && !isReservedId(namespaced.slice(0, index));
}
