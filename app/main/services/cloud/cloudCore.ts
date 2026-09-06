/**
 * Shared types for the cloud staging layer. Pure — no `electron`, no network —
 * so `test/` imports it directly (the jsonStore/stateStore split).
 *
 * The layer's whole premise: a remote file is downloaded into a local staging
 * directory and the *staged* path is the only path the rest of the app ever
 * sees. Routing, `allowRoot()`, both hosts' `fs` calls and the submodules' own
 * MCP servers keep working unmodified because nothing below this layer knows a
 * file is remote.
 */

export type ProviderId = "gdrive" | "dropbox" | "onedrive";

export const PROVIDER_IDS: readonly ProviderId[] = ["gdrive", "dropbox", "onedrive"];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  gdrive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
};

/** A remote file or folder as the browser and the sync engine see it. */
export interface CloudFile {
  /** Drive fileId | Dropbox path_lower | Graph itemId. Opaque to us. */
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  /**
   * The provider's change token: Drive `headRevisionId`, Dropbox `rev`, Graph
   * `cTag` (**not** `eTag`, which also moves on pure metadata edits and would
   * manufacture phantom conflicts).
   */
  rev?: string;
  /**
   * The token a conditional overwrite must quote, when the provider supports
   * one and it is NOT the same string as `rev`. Graph is why this exists: the
   * sync baseline is `cTag` (content changes only) but the precondition Graph
   * accepts on the wire is `eTag`. Dropbox uses one token for both; Drive has
   * no conditional media write at all and leaves this undefined.
   */
  precondition?: string;
  hash?: string;
  modifiedAt?: number;
  parentId?: string;
  /** Graph's short-lived pre-authenticated URL. Must NOT get an Authorization header. */
  downloadUrl?: string;
}

/** Enough to re-fetch a file in a later session — what a recent entry stores. */
export interface CloudRef {
  provider: ProviderId;
  accountId: string;
  itemId: string;
  name: string;
  parentId?: string;
  /** Display path of the containing folder, for the recents description. */
  folder?: string;
}

export interface CloudAccount {
  id: string;
  /** What the user sees in the menu: an email or display name. */
  label: string;
}

export type CloudErrorKind =
  | "auth"
  | "network"
  | "notFound"
  | "conflict"
  | "quota"
  | "noClient"
  | "other";

/** Mirrors chat/providers/types.ts's ProviderError, so the toast layer can
 *  branch on a kind instead of matching message text. */
export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/**
 * stateStore / secrets keys. One table, the META_SERVER_KEYS precedent.
 *
 * The `cloud.` prefix matters: mesh's `globalState` maps straight onto the
 * stateStore with **no namespace**, so its keys are reserved app-wide and a
 * mesh bump can claim a new one. `grep -rni "cloud" mesh/src` is clean today
 * and should be re-run on every mesh bump.
 */
export const CLOUD_KEYS = {
  /** Public by OAuth spec — plain stateStore, not a secret. */
  clientId: (p: ProviderId) => `cloud.${p}.clientId`,
  /** `{id, label}` of the connected account. */
  account: (p: ProviderId) => `cloud.${p}.account`,
  /** safeStorage-encrypted via chat/secrets.ts. */
  clientSecret: (p: ProviderId) => `cloud.${p}.clientSecret`,
  refreshToken: (p: ProviderId) => `cloud.${p}.refreshToken`,
  cacheLimitMb: "cloudCacheLimitMb",
} as const;

export const DEFAULT_CACHE_LIMIT_MB = 2048;

/** Coalesces a burst of sidecar writes into one upload pass. Deliberately
 *  larger than cadHost's PARTS_SAVE_DEBOUNCE_MS (500) so it swallows it. */
export const CLOUD_UPLOAD_DEBOUNCE_MS = 3_000;

export function parseAccount(value: unknown): CloudAccount | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, label } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id) return undefined;
  return { id, label: typeof label === "string" && label ? label : id };
}
