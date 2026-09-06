/**
 * Google Drive v3, over plain REST — no SDK, same reasoning as dropbox.ts.
 *
 * Three things make Drive the awkward one:
 *
 * - **No paths.** Browsing is a parent-id drill-down from the alias `"root"`,
 *   and `findChild` is a `q=` search whose quoting we own (gdriveCore).
 * - **No reliable conditional media overwrite.** Drive has no `If-Match` for a
 *   content update, so the conflict guard here is check-then-upload with a
 *   documented residual window: another writer landing between our `stat()` and
 *   the session's final chunk wins. Dropbox refuses such a write server-side;
 *   Drive cannot, and pretending otherwise would be worse than saying so.
 * - **Scope.** `drive.file` only sees files the app itself created or the user
 *   picked through *Google's* Picker, which we do not use — so our own browser
 *   needs full `drive`. That is stated in the consent screen and in the docs.
 *
 * A "Desktop app" client is issued a client secret. Google's own installed-app
 * documentation says it is not treated as confidential; we still keep it in the
 * safeStorage-encrypted store rather than in the clear.
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
  childrenQuery,
  DRIVE_ROOT,
  FILE_FIELDS,
  LIST_FIELDS,
  parseAboutUser,
  parseFileList,
  parseFileMeta,
} from "../providerCore/gdriveCore";
import { byFolderThenName } from "./dropbox";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
/**
 * Below this a single request beats a resumable session — three round trips for
 * a 2 KB sidecar — and a resumable session cannot finalise a zero-byte file at
 * all, so this is a correctness fix as much as an optimisation.
 */
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const MULTIPART_BOUNDARY = "kkss-drive-boundary";

export class GoogleDriveProvider extends OAuthProviderBase {
  readonly id = "gdrive" as const;
  readonly label = "Google Drive";
  readonly needsClientSecret = true;

  constructor(store: ProviderStore) {
    super(store);
  }

  protected oauthConfig(clientId: string, clientSecret?: string): OAuthConfig {
    return {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // Not drive.file: that scope cannot see files our own browser lists.
      scopes: ["https://www.googleapis.com/auth/drive"],
      clientId,
      clientSecret,
      redirectPort: 0, // Google accepts a loopback redirect on any port.
      extraAuthParams: {
        access_type: "offline",
        // Without prompt=consent a re-authorization returns no refresh token,
        // and we would need a browser round trip every hour.
        prompt: "consent",
      },
    };
  }

  protected async fetchAccount(): Promise<CloudAccount> {
    const account = parseAboutUser(
      await this.json(`${API}/about?fields=user(emailAddress,displayName,permissionId)`)
    );
    if (!account) {
      throw new CloudError("auth", "Google Drive did not identify the signed-in account.");
    }
    return account;
  }

  async list(folderId: string | undefined, pageToken?: string): Promise<ListPage> {
    const url = new URL(`${API}/files`);
    url.searchParams.set("q", childrenQuery(folderId ?? DRIVE_ROOT));
    url.searchParams.set("fields", LIST_FIELDS);
    url.searchParams.set("pageSize", "200");
    url.searchParams.set("orderBy", "folder,name");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = parseFileList(await this.json(url.toString()));
    return { files: page.files.sort(byFolderThenName), nextPageToken: page.nextPageToken };
  }

  async stat(fileId: string): Promise<CloudFile> {
    const file = parseFileMeta(
      await this.json(`${API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`)
    );
    if (!file) throw new CloudError("notFound", `Google Drive has no file ${fileId}.`);
    return file;
  }

  async findChild(parentId: string, name: string): Promise<CloudFile | undefined> {
    const url = new URL(`${API}/files`);
    url.searchParams.set("q", childrenQuery(parentId, name));
    url.searchParams.set("fields", LIST_FIELDS);
    url.searchParams.set("pageSize", "1");
    return parseFileList(await this.json(url.toString())).files[0];
  }

  async download(file: CloudFile, destPath: string, options: TransferOptions = {}): Promise<void> {
    const response = await this.authed(
      `${API}/files/${encodeURIComponent(file.id)}?alt=media`,
      { signal: options.signal }
    );
    if (!response.ok) await this.fail(response, "download");
    await downloadResponseTo(response, destPath, file.size, options.onProgress);
  }

  async upload(
    fileId: string,
    localPath: string,
    options: TransferOptions & { precondition?: string } = {}
  ): Promise<CloudFile> {
    // The caller has already compared revisions (cloudSync). Drive offers no
    // server-side conditional for a content update, so there is nothing more we
    // can do here than not invent a guarantee we do not have.
    const size = await readLocalSize(localPath);
    if (size <= SIMPLE_UPLOAD_LIMIT) {
      const simple = await this.authed(
        `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${FILE_FIELDS}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/octet-stream" },
          body: asBody(await readLocalBytes(localPath)),
          signal: options.signal,
        }
      );
      return this.parseUploaded(simple, options, size);
    }
    const start = await this.authed(
      `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: "{}",
        signal: options.signal,
      }
    );
    return this.finishResumable(start, localPath, size, options);
  }

  async create(
    parentId: string,
    name: string,
    localPath: string,
    options: TransferOptions = {}
  ): Promise<CloudFile> {
    const size = await readLocalSize(localPath);
    if (size <= SIMPLE_UPLOAD_LIMIT) {
      // Drive's create has no `media` form — the metadata and the bytes have to
      // travel together as multipart/related.
      const simple = await this.authed(
        `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
        {
          method: "POST",
          headers: { "content-type": `multipart/related; boundary=${MULTIPART_BOUNDARY}` },
          body: asBody(
            multipartBody({ name, parents: [parentId] }, await readLocalBytes(localPath))
          ),
          signal: options.signal,
        }
      );
      return this.parseUploaded(simple, options, size);
    }
    const start = await this.authed(
      `${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, parents: [parentId] }),
        signal: options.signal,
      }
    );
    return this.finishResumable(start, localPath, size, options);
  }

  /** Takes the session-init response's `Location` and streams the file to it. */
  private async finishResumable(
    start: Response,
    localPath: string,
    size: number,
    options: TransferOptions
  ): Promise<CloudFile> {
    if (!start.ok) await this.fail(start, "upload");
    const uploadUrl = start.headers.get("location");
    if (!uploadUrl) {
      throw new CloudError("other", "Google Drive did not return an upload session URL.");
    }
    const response = await uploadChunked({
      localPath,
      size,
      onProgress: options.onProgress,
      // The session URL carries its own credentials, so this is a bare send.
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
    const file = parseFileMeta(await response.json());
    if (!file) throw new CloudError("other", "Google Drive returned no metadata for the upload.");
    options.onProgress?.(size, size);
    return file;
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.authed(url);
    if (!response.ok) await this.fail(response, "request");
    return response.json();
  }
}

/** `multipart/related`: a JSON metadata part, then the raw bytes. */
function multipartBody(metadata: unknown, bytes: Uint8Array): Uint8Array {
  const head = Buffer.from(
    `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--\r\n`, "utf8");
  return Buffer.concat([head, bytes, tail]);
}
