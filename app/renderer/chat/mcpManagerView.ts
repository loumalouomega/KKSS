/**
 * Pure view-model helpers for the MCP manager panel — everything about the
 * panel that is a decision rather than DOM, so it is unit-tested without one.
 *
 * Validation of ids, urls and the bearer-token rule is deliberately **not**
 * duplicated here: main owns it (`userServers.ts`) and answers a bad submit with
 * `mcpError`, whose detail the form shows. The renderer only checks that a
 * required field is present, so the two cannot drift.
 */
import type { ChatMcpProject, ChatMcpServerInput, ChatMcpServerRow } from "../../main/ipc";

/**
 * Splits an arguments line the way a user types it: whitespace separates,
 * single or double quotes group, and inside double quotes `\"` and `\\` escape.
 * There is no shell involved anywhere — the result is an argv array — so no
 * expansion, globbing or redirection exists to be surprised by. A backslash
 * outside double quotes is literal, which keeps Windows paths intact.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) { out.push(current); current = ""; started = false; }
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** The inverse of `splitArgs`, for showing a stored argument list in the form. */
export function joinArgs(args: readonly string[]): string {
  return args
    .map((arg) => (arg === "" || /[\s"']/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}

export interface FormValues {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  env: Array<{ name: string; value: string }>;
  token: string;
  clearToken: boolean;
}

export type FormProblem = "id" | "command" | "url";

/**
 * Builds the `mcpSaveServer` payload. A blank env value or token means *keep what
 * is stored* (the renderer never knows the stored value), which is why a new
 * server's blank value simply stores nothing.
 */
export function buildInput(values: FormValues): { ok: true; input: ChatMcpServerInput } | { ok: false; problems: FormProblem[] } {
  const problems: FormProblem[] = [];
  const id = values.id.trim();
  if (!id) problems.push("id");
  if (values.transport === "stdio" && !values.command.trim()) problems.push("command");
  if (values.transport === "http" && !values.url.trim()) problems.push("url");
  if (problems.length) return { ok: false, problems };
  const name = values.name.trim();
  if (values.transport === "stdio") {
    const seen = new Set<string>();
    const env = values.env
      .map((e) => ({ name: e.name.trim(), value: e.value }))
      .filter((e) => e.name && !seen.has(e.name) && !!seen.add(e.name))
      .map((e) => (e.value === "" ? { name: e.name } : e));
    return { ok: true, input: { id, ...(name ? { name } : {}), transport: "stdio", command: values.command.trim(), args: splitArgs(values.args), env } };
  }
  const token = values.clearToken ? "" : values.token === "" ? undefined : values.token;
  return { ok: true, input: { id, ...(name ? { name } : {}), transport: "http", url: values.url.trim(), ...(token !== undefined ? { token } : {}) } };
}

export interface RowActions {
  restart: boolean;
  toggle: boolean;
  edit: boolean;
  remove: boolean;
  tools: boolean;
}

/** Which controls a row offers. Built-ins restart only; a project server follows
 *  its file, so it cannot be edited, removed or toggled here. */
export function rowActions(row: ChatMcpServerRow, managed: boolean): RowActions {
  const user = row.source === "user";
  return {
    restart: row.state !== "disabled" && row.state !== "untrusted" && row.state !== "starting",
    toggle: user && !managed,
    edit: user && !managed,
    remove: user && !managed,
    tools: row.state === "ready" && (row.toolCount ?? 0) > 0,
  };
}

export interface ProjectActions { trust: boolean; revoke: boolean; reload: boolean }

export function projectActions(project: ChatMcpProject, managed: boolean): ProjectActions {
  return {
    trust: !managed && (project.state === "untrusted" || project.state === "changed"),
    revoke: !managed && (project.state === "trusted" || project.state === "changed"),
    reload: project.state !== "none" || !!project.root,
  };
}

/** Sort: built-ins first (their order is the app's), then user, then project servers. */
export function orderRows(rows: readonly ChatMcpServerRow[]): ChatMcpServerRow[] {
  const rank = { builtin: 0, user: 1, project: 2 } as const;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank[a.row.source] - rank[b.row.source] || a.index - b.index).map((x) => x.row);
}
