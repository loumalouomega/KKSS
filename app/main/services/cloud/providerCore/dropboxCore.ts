/**
 * Pure parsing and header encoding for the Dropbox provider.
 *
 * Dropbox is **path-based**: `""` is the root, and a file's identity for every
 * content operation is its `path_lower`. (There is also a stable `id:…`, but
 * every endpoint we use accepts a path, and a path is what makes `findChild`
 * a string operation instead of a search.)
 *
 * The one genuinely dangerous detail is `Dropbox-API-Arg`: the request
 * arguments travel in an HTTP *header*, which must be pure ASCII. A model named
 * `pièce.stp` fails with an opaque 400 unless every non-ASCII codepoint is
 * escaped — hence `apiArgHeader`, tested against exactly that name.
 */
import type { CloudAccount, CloudFile } from "../cloudCore";

/**
 * JSON for the `Dropbox-API-Arg` header, with every non-ASCII codepoint
 * escaped as `\uXXXX`. Dropbox unescapes them server-side, so this is lossless.
 */
export function apiArgHeader(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uFFFF]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** The containing folder of a Dropbox path — `""` for an item at the root. */
export function dropboxParentOf(pathLower: string): string {
  const cut = pathLower.lastIndexOf("/");
  return cut <= 0 ? "" : pathLower.slice(0, cut);
}

export function parseEntry(raw: unknown): CloudFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const tag = v[".tag"];
  if (tag !== "file" && tag !== "folder") return undefined; // "deleted", or unknown
  const path = typeof v.path_lower === "string" ? v.path_lower : undefined;
  const name = typeof v.name === "string" ? v.name : undefined;
  if (!path || !name) return undefined;
  const isFolder = tag === "folder";
  return {
    id: path,
    name,
    isFolder,
    parentId: dropboxParentOf(path),
    size: typeof v.size === "number" ? v.size : undefined,
    rev: !isFolder && typeof v.rev === "string" ? v.rev : undefined,
    // Dropbox's `mode.update` quotes the same rev, so the two coincide here.
    precondition: !isFolder && typeof v.rev === "string" ? v.rev : undefined,
    hash: typeof v.content_hash === "string" ? v.content_hash : undefined,
    modifiedAt:
      typeof v.server_modified === "string" ? Date.parse(v.server_modified) || undefined : undefined,
  };
}

export interface DropboxListPage {
  files: CloudFile[];
  cursor?: string;
  hasMore: boolean;
}

/** `list_folder` and `list_folder/continue` answer in the same shape. */
export function parseListFolder(raw: unknown): DropboxListPage {
  const v = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(v.entries) ? v.entries : [];
  return {
    files: entries.map(parseEntry).filter((f): f is CloudFile => f !== undefined),
    cursor: typeof v.cursor === "string" ? v.cursor : undefined,
    hasMore: v.has_more === true,
  };
}

/** `users/get_current_account` — the label the Settings menu shows. */
export function parseAccountInfo(raw: unknown): CloudAccount | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const id = typeof v.account_id === "string" ? v.account_id : undefined;
  if (!id) return undefined;
  const email = typeof v.email === "string" ? v.email : undefined;
  const name = v.name && typeof v.name === "object" ? (v.name as Record<string, unknown>) : {};
  const display = typeof name.display_name === "string" ? name.display_name : undefined;
  return { id, label: email ?? display ?? id };
}

/**
 * Whether an upload rejection is the conditional-write conflict we asked for.
 * Dropbox is the only one of the three with a true server-enforced conditional
 * overwrite (`mode: {".tag": "update", update: <rev>}`), so this is the one
 * place a conflict is detected by the provider rather than by our own
 * check-then-upload.
 */
export function isConflictBody(raw: unknown): boolean {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  return text.includes("conflict");
}
