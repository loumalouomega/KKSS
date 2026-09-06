/**
 * Dropbox, via the plain REST API — no SDK. KKSS is AGPL-3.0 and every shipped
 * dependency has to be checked for compatibility, so three endpoints' worth of
 * work does not justify dragging a vendor SDK's transitive tree into
 * `out/main.js`. `net.fetch` (the house style, services/updates.ts) covers all
 * of it.
 *
 * Dropbox is the reference implementation of the provider contract because it
 * is the simplest of the three *and* the strictest: it is the only one with a
 * true server-enforced conditional overwrite, so a lost update is refused by
 * the server rather than merely avoided by our own check-then-upload.
 *
 * Two asymmetries the other providers do not share:
 *
 * - **The redirect URI must be registered exactly**, so the loopback listener
 *   pins a port instead of taking an ephemeral one. The user pastes
 *   `http://127.0.0.1:53682/callback` into their app console.
 * - **Request arguments travel in an HTTP header** (`Dropbox-API-Arg`), which
 *   must be pure ASCII — see `apiArgHeader`.
 */
import { CloudError, type CloudAccount, type CloudFile } from "../cloudCore";
import {
  OAuthProviderBase,
  type ListPage,
  type ProviderStore,
  type TransferOptions,
} from "../cloudProvider";
import type { OAuthConfig } from "../oauth";
import { asBody, downloadResponseTo, readChunk, readLocalBytes, readLocalSize } from "../transfer";
import { nextChunkRange } from "../uploadChunkCore";
import {
  apiArgHeader,
  dropboxParentOf,
  isConflictBody,
  parseAccountInfo,
  parseEntry,
  parseListFolder,
} from "../providerCore/dropboxCore";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
/** Dropbox's console requires an exact redirect URI, so this cannot float. */
export const DROPBOX_REDIRECT_PORT = 53682;
/** Above this the simple endpoint refuses and an upload session is required.
 *  This is the one place a size branch is justified: below the limit the
 *  single-request endpoint is genuinely cheaper (one round trip, no session). */
const SIMPLE_UPLOAD_LIMIT = 150 * 1024 * 1024;
/** Dropbox recommends 8–32 MB per append; a mesh export is routinely in that
 *  range, so a bigger chunk mostly means fewer round trips. */
const SESSION_CHUNK_SIZE = 16 * 1024 * 1024;

export class DropboxProvider extends OAuthProviderBase {
  readonly id = "dropbox" as const;
  readonly label = "Dropbox";
  /** PKCE public client — Dropbox issues no secret for a desktop app. */
  readonly needsClientSecret = false;

  constructor(store: ProviderStore) {
    super(store);
  }

  protected oauthConfig(clientId: string): OAuthConfig {
    return {
      authUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: ["files.metadata.read", "files.content.read", "files.content.write", "account_info.read"],
      clientId,
      redirectPort: DROPBOX_REDIRECT_PORT,
      // Without this Dropbox issues a short-lived token and no refresh token.
      extraAuthParams: { token_access_type: "offline" },
    };
  }

  protected async fetchAccount(): Promise<CloudAccount> {
    // This endpoint is the one RPC call that takes a literal `null` body.
    const raw = await this.rpc("users/get_current_account", null);
    const account = parseAccountInfo(raw);
    if (!account) throw new CloudError("auth", "Dropbox did not identify the signed-in account.");
    return account;
  }

  async list(folderId: string | undefined, pageToken?: string): Promise<ListPage> {
    const raw = pageToken
      ? await this.rpc("files/list_folder/continue", { cursor: pageToken })
      : await this.rpc("files/list_folder", { path: folderId ?? "", limit: 500 });
    const page = parseListFolder(raw);
    return {
      // Folders first, then files, each alphabetically — the drill-down picker
      // shows this list verbatim.
      files: page.files.sort(byFolderThenName),
      nextPageToken: page.hasMore ? page.cursor : undefined,
    };
  }

  async stat(fileId: string): Promise<CloudFile> {
    const file = parseEntry(await this.rpc("files/get_metadata", { path: fileId }));
    if (!file) throw new CloudError("notFound", `Dropbox has no file at ${fileId}.`);
    return file;
  }

  async findChild(parentId: string, name: string): Promise<CloudFile | undefined> {
    // Path-based, so this is a direct lookup rather than a search.
    try {
      return await this.stat(`${parentId}/${name}`.replace(/\/+/g, "/"));
    } catch (err) {
      if (err instanceof CloudError && err.kind === "notFound") return undefined;
      // get_metadata answers 409 for "path/not_found", which maps to conflict.
      if (err instanceof CloudError && err.kind === "conflict") return undefined;
      throw err;
    }
  }

  async download(file: CloudFile, destPath: string, options: TransferOptions = {}): Promise<void> {
    const response = await this.authed(`${CONTENT}/files/download`, {
      method: "POST",
      headers: { "Dropbox-API-Arg": apiArgHeader({ path: file.id }) },
      signal: options.signal,
    });
    if (!response.ok) await this.fail(response, "download");
    await downloadResponseTo(response, destPath, file.size, options.onProgress);
  }

  async upload(
    fileId: string,
    localPath: string,
    options: TransferOptions & { precondition?: string } = {}
  ): Promise<CloudFile> {
    // The conditional the whole conflict story rests on: `update` refuses when
    // the remote has moved on, and `autorename: false` makes it refuse rather
    // than silently write a "(1)" copy we would never notice.
    const mode = options.precondition
      ? { ".tag": "update", update: options.precondition }
      : { ".tag": "overwrite" };
    return this.put(fileId, localPath, mode, options);
  }

  async create(
    parentId: string,
    name: string,
    localPath: string,
    options: TransferOptions = {}
  ): Promise<CloudFile> {
    const path = `${parentId}/${name}`.replace(/\/+/g, "/");
    return this.put(path, localPath, { ".tag": "add" }, options);
  }

  private async put(
    path: string,
    localPath: string,
    mode: unknown,
    options: TransferOptions
  ): Promise<CloudFile> {
    const size = await readLocalSize(localPath);
    const commit = { path, mode, autorename: false, mute: true };
    const response =
      size > SIMPLE_UPLOAD_LIMIT
        ? await this.putSession(localPath, size, commit, options)
        : await this.putSimple(localPath, commit, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Dropbox is the only provider that refuses a stale conditional write
      // server-side; the other two need our own check-then-upload.
      if (isConflictBody(text)) {
        throw new CloudError("conflict", `${path} changed on Dropbox since KKSS last synced it.`);
      }
      throw new CloudError(
        "other",
        `Dropbox upload failed (${response.status}): ${text.slice(0, 300)}`
      );
    }
    options.onProgress?.(size, size);
    const file = parseEntry(await response.json());
    if (!file) throw new CloudError("other", `Dropbox returned no metadata for ${path}.`);
    return file;
  }

  private async putSimple(
    localPath: string,
    commit: Record<string, unknown>,
    options: TransferOptions
  ): Promise<Response> {
    return this.authed(`${CONTENT}/files/upload`, {
      method: "POST",
      headers: {
        "Dropbox-API-Arg": apiArgHeader(commit),
        "content-type": "application/octet-stream",
      },
      body: asBody(await readLocalBytes(localPath)),
      signal: options.signal,
    });
  }

  /** start → append_v2 … → finish. Only the finish call answers with metadata,
   *  so it is the Response the caller inspects. */
  private async putSession(
    localPath: string,
    size: number,
    commit: Record<string, unknown>,
    options: TransferOptions
  ): Promise<Response> {
    const first = nextChunkRange(size, 0, SESSION_CHUNK_SIZE)!;
    const started = await this.content(
      "files/upload_session/start",
      { close: false },
      await readChunk(localPath, first.start, first.length),
      options
    );
    if (!started.ok) await this.fail(started, "upload");
    const sessionId = (await started.json()) as { session_id?: string };
    if (!sessionId.session_id) {
      throw new CloudError("other", "Dropbox did not return an upload session id.");
    }
    let offset = first.length;
    options.onProgress?.(offset, size);

    for (let chunk = nextChunkRange(size, offset, SESSION_CHUNK_SIZE); chunk; ) {
      const appended = await this.content(
        "files/upload_session/append_v2",
        { cursor: { session_id: sessionId.session_id, offset: chunk.start }, close: false },
        await readChunk(localPath, chunk.start, chunk.length),
        options
      );
      if (!appended.ok) await this.fail(appended, "upload");
      offset = chunk.start + chunk.length;
      options.onProgress?.(offset, size);
      chunk = nextChunkRange(size, offset, SESSION_CHUNK_SIZE);
    }

    return this.content(
      "files/upload_session/finish",
      { cursor: { session_id: sessionId.session_id, offset: size }, commit },
      new Uint8Array(0),
      options
    );
  }

  /** A content-endpoint call: arguments in the header, bytes in the body. */
  private content(
    endpoint: string,
    arg: unknown,
    body: Uint8Array,
    options: TransferOptions
  ): Promise<Response> {
    return this.authed(`${CONTENT}/${endpoint}`, {
      method: "POST",
      headers: {
        "Dropbox-API-Arg": apiArgHeader(arg),
        "content-type": "application/octet-stream",
      },
      body: asBody(body),
      signal: options.signal,
    });
  }

  /** A JSON-in, JSON-out RPC call against api.dropboxapi.com. */
  private async rpc(endpoint: string, body: unknown): Promise<unknown> {
    const response = await this.authed(`${API}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) await this.fail(response, endpoint);
    return response.json();
  }
}

export function byFolderThenName(a: CloudFile, b: CloudFile): number {
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export { dropboxParentOf };
