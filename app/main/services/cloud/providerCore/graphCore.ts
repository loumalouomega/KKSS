/**
 * Pure parsing for the OneDrive (Microsoft Graph) provider.
 *
 * The one decision that matters here is **`cTag`, not `eTag`, is the revision.**
 * Graph moves `eTag` on any change to the item including pure metadata edits
 * (a rename, a shared link, an OneDrive-side thumbnail refresh), so using it as
 * a conflict baseline would manufacture a `(conflict …)` copy every time the
 * service touched the file for its own reasons. `cTag` moves only when the
 * *content* changes, which is the question the sync engine is actually asking.
 */
import type { CloudAccount, CloudFile } from "../cloudCore";

/** Graph hands out a short-lived pre-authenticated CDN URL for downloads.
 *  Sending an Authorization header to it makes the CDN reject the request. */
export const DOWNLOAD_URL_KEY = "@microsoft.graph.downloadUrl";

export function parseDriveItem(raw: unknown): CloudFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id : undefined;
  const name = typeof v.name === "string" ? v.name : undefined;
  if (!id || !name) return undefined;
  const parent =
    v.parentReference && typeof v.parentReference === "object"
      ? (v.parentReference as Record<string, unknown>)
      : {};
  const hashes =
    v.file && typeof v.file === "object"
      ? ((v.file as Record<string, unknown>).hashes as Record<string, unknown> | undefined)
      : undefined;
  return {
    id,
    name,
    isFolder: v.folder !== undefined,
    size: typeof v.size === "number" ? v.size : undefined,
    // cTag, deliberately — see the module comment.
    rev: typeof v.cTag === "string" ? v.cTag : undefined,
    // ...but `if-match` only accepts eTag, so both are carried.
    precondition: typeof v.eTag === "string" ? v.eTag : undefined,
    hash:
      typeof hashes?.quickXorHash === "string"
        ? hashes.quickXorHash
        : typeof hashes?.sha256Hash === "string"
          ? hashes.sha256Hash
          : undefined,
    modifiedAt:
      typeof v.lastModifiedDateTime === "string"
        ? Date.parse(v.lastModifiedDateTime) || undefined
        : undefined,
    parentId: typeof parent.id === "string" ? parent.id : undefined,
    downloadUrl: typeof v[DOWNLOAD_URL_KEY] === "string" ? (v[DOWNLOAD_URL_KEY] as string) : undefined,
  };
}

export interface GraphListPage {
  files: CloudFile[];
  nextLink?: string;
}

/** `/children` — paged with a full `@odata.nextLink` URL, not a bare token. */
export function parseChildren(raw: unknown): GraphListPage {
  const v = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(v.value) ? v.value : [];
  return {
    files: entries.map(parseDriveItem).filter((f): f is CloudFile => f !== undefined),
    nextLink: typeof v["@odata.nextLink"] === "string" ? (v["@odata.nextLink"] as string) : undefined,
  };
}

/** `/me` — the label the Settings menu shows. */
export function parseGraphUser(raw: unknown): CloudAccount | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id : undefined;
  if (!id) return undefined;
  const upn = typeof v.userPrincipalName === "string" ? v.userPrincipalName : undefined;
  const mail = typeof v.mail === "string" ? v.mail : undefined;
  const display = typeof v.displayName === "string" ? v.displayName : undefined;
  return { id, label: mail ?? upn ?? display ?? id };
}

/** The upload URL out of a createUploadSession response. */
export function parseUploadSession(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const url = (raw as Record<string, unknown>).uploadUrl;
  return typeof url === "string" ? url : undefined;
}
