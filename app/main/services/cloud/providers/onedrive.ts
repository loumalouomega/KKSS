/**
 * OneDrive via Microsoft Graph, over plain REST — no SDK, same reasoning as
 * dropbox.ts.
 *
 * The defining constraint: **`PUT /items/{id}/content` is capped at 4 MB**, so
 * `createUploadSession` plus ranged PUTs is not an optimisation for large files
 * here, it is the only path that works for essentially every real CAD or mesh
 * document. There is deliberately no size branch — one code path, always, which
 * also gives progress reporting for free.
 *
 * Conditional writes use `if-match` against the item's eTag on session
 * creation, alongside `conflictBehavior: "fail"`. Note the asymmetry with the
 * revision baseline: the sync engine compares `cTag` (content changes only),
 * but the wire-level precondition Graph accepts is `eTag`. Both are carried on
 * the CloudFile so neither has to be re-fetched.
 */
import { CloudError, type CloudAccount, type CloudFile } from "../cloudCore";
import {
  OAuthProviderBase,
  type ListPage,
  type ProviderStore,
  type TransferOptions,
} from "../cloudProvider";
import type { OAuthConfig } from "../oauth";
import {
  asBody,
  downloadResponseTo,
  readLocalBytes,
  readLocalSize,
  uploadChunked,
} from "../transfer";
import {
  parseChildren,
  parseDriveItem,
  parseGraphUser,
  parseUploadSession,
} from "../providerCore/graphCore";
import { byFolderThenName } from "./dropbox";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DRIVE = `${GRAPH}/me/drive`;
/** Everything a CloudFile needs; `select` keeps the pages small. */
const SELECT = "id,name,size,cTag,eTag,folder,file,parentReference,lastModifiedDateTime";
/**
 * Graph's simple `PUT .../content` ceiling. Below it the session machinery is
 * pure overhead — three requests for a 2 KB sidecar — and an upload session is
 * not supported for a zero-byte file at all, so a small-file path is a
 * correctness fix as much as an optimisation.
 */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

export class OneDriveProvider extends OAuthProviderBase {
  readonly id = "onedrive" as const;
  readonly label = "OneDrive";
  /** Public client + PKCE — a desktop app registration issues no secret. */
  readonly needsClientSecret = false;

  constructor(store: ProviderStore) {
    super(store);
  }

  protected oauthConfig(clientId: string): OAuthConfig {
    return {
      authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      // offline_access is what makes a refresh token appear at all.
      scopes: ["Files.ReadWrite", "offline_access", "User.Read"],
      clientId,
      redirectPort: 0, // Microsoft accepts a loopback redirect on any port.
    };
  }

  protected async fetchAccount(): Promise<CloudAccount> {
    const account = parseGraphUser(await this.json(`${GRAPH}/me`));
    if (!account) throw new CloudError("auth", "OneDrive did not identify the signed-in account.");
    return account;
  }

  async list(folderId: string | undefined, pageToken?: string): Promise<ListPage> {
    // A nextLink is a complete URL, so it replaces the request rather than
    // being appended as a parameter.
    const url =
      pageToken ??
      (folderId
        ? `${DRIVE}/items/${encodeURIComponent(folderId)}/children?$select=${SELECT}&$top=200`
        : `${DRIVE}/root/children?$select=${SELECT}&$top=200`);
    const page = parseChildren(await this.json(url));
    return { files: page.files.sort(byFolderThenName), nextPageToken: page.nextLink };
  }

  async stat(fileId: string): Promise<CloudFile> {
    const file = parseDriveItem(
      await this.json(`${DRIVE}/items/${encodeURIComponent(fileId)}?$select=${SELECT}`)
    );
    if (!file) throw new CloudError("notFound", `OneDrive has no item ${fileId}.`);
    return file;
  }

  async findChild(parentId: string, name: string): Promise<CloudFile | undefined> {
    // Graph's path-relative addressing: `/items/{id}:/{name}:`
    const url = `${DRIVE}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}:?$select=${SELECT}`;
    const response = await this.authed(url);
    if (response.status === 404) return undefined;
    if (!response.ok) await this.fail(response, "lookup");
    return parseDriveItem(await response.json());
  }

  async download(file: CloudFile, destPath: string, options: TransferOptions = {}): Promise<void> {
    // The pre-authenticated CDN URL expires, so a stale CloudFile is re-stat'ed
    // rather than used; and it must NOT carry our Authorization header.
    const url = file.downloadUrl ?? (await this.stat(file.id)).downloadUrl;
    const response = url
      ? await this.send(url, { signal: options.signal })
      : await this.authed(`${DRIVE}/items/${encodeURIComponent(file.id)}/content`, {
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
    const size = await readLocalSize(localPath);
    if (size <= SIMPLE_UPLOAD_LIMIT) {
      const simple = await this.authed(`${DRIVE}/items/${encodeURIComponent(fileId)}/content`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          ...(options.precondition ? { "if-match": options.precondition } : {}),
        },
        body: asBody(await readLocalBytes(localPath)),
        signal: options.signal,
      });
      if (simple.status === 412) {
        throw new CloudError("conflict", "The file changed on OneDrive since KKSS last synced it.");
      }
      return this.parseUploaded(simple, options, size);
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.precondition) headers["if-match"] = options.precondition;
    const session = await this.authed(
      `${DRIVE}/items/${encodeURIComponent(fileId)}/createUploadSession`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } }),
        signal: options.signal,
      }
    );
    if (session.status === 412) {
      throw new CloudError("conflict", "The file changed on OneDrive since KKSS last synced it.");
    }
    return this.finishSession(session, localPath, size, options);
  }

  async create(
    parentId: string,
    name: string,
    localPath: string,
    options: TransferOptions = {}
  ): Promise<CloudFile> {
    const size = await readLocalSize(localPath);
    if (size <= SIMPLE_UPLOAD_LIMIT) {
      const simple = await this.authed(
        `${DRIVE}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: asBody(await readLocalBytes(localPath)),
          signal: options.signal,
        }
      );
      return this.parseUploaded(simple, options, size);
    }
    const session = await this.authed(
      `${DRIVE}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}:/createUploadSession`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A conflict copy must never silently become "name 1.stp".
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "fail" } }),
        signal: options.signal,
      }
    );
    return this.finishSession(session, localPath, size, options);
  }

  private async finishSession(
    session: Response,
    localPath: string,
    size: number,
    options: TransferOptions
  ): Promise<CloudFile> {
    if (!session.ok) await this.fail(session, "upload");
    const uploadUrl = parseUploadSession(await session.json());
    if (!uploadUrl) throw new CloudError("other", "OneDrive did not return an upload session URL.");
    const response = await uploadChunked({
      localPath,
      size,
      onProgress: options.onProgress,
      // The session URL is itself pre-authenticated.
      send: (body, contentRange) =>
        this.send(uploadUrl, {
          method: "PUT",
          headers: { "content-range": contentRange },
          body: asBody(body),
          signal: options.signal,
        }),
    });
    return this.parseUploaded(response, options, size);
  }

  /** Both upload paths end the same way: check, parse, report done. */
  private async parseUploaded(
    response: Response,
    options: TransferOptions,
    size: number
  ): Promise<CloudFile> {
    if (!response.ok) await this.fail(response, "upload");
    const file = parseDriveItem(await response.json());
    if (!file) throw new CloudError("other", "OneDrive returned no metadata for the upload.");
    options.onProgress?.(size, size);
    return file;
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.authed(url);
    if (!response.ok) await this.fail(response, "request");
    return response.json();
  }
}
