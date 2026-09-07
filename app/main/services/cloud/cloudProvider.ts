/**
 * What every cloud provider has to offer the staging layer, and the token
 * plumbing they all share.
 *
 * The interface is deliberately file-oriented rather than API-shaped: browse,
 * fetch bytes, push bytes, and tell me the revision. Everything that differs
 * between Drive, Dropbox and Graph — ids vs paths, resumable-upload mechanics,
 * which header carries the conditional — stays inside each implementation.
 */
import { net } from "electron";
import { CloudError, type CloudAccount, type CloudFile, type ProviderId } from "./cloudCore";
import type { OAuthConfig } from "./oauth";
import { refreshTokens, runLoopbackAuth } from "./oauth";
import type { TokenSet } from "./oauthCore";

export interface ListPage {
  files: CloudFile[];
  nextPageToken?: string;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total?: number) => void;
}

export interface CloudProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Whether the provider's console issues a secret for a desktop client. */
  readonly needsClientSecret: boolean;

  connect(): Promise<CloudAccount>;
  disconnect(): Promise<void>;
  account(): CloudAccount | undefined;
  isConnected(): boolean;

  /** `undefined` folder id means the account's root. */
  list(folderId: string | undefined, pageToken?: string): Promise<ListPage>;
  stat(fileId: string): Promise<CloudFile>;
  findChild(parentId: string, name: string): Promise<CloudFile | undefined>;

  download(file: CloudFile, destPath: string, options?: TransferOptions): Promise<void>;
  /** Overwrites an existing item, conditionally where the provider supports it. */
  upload(
    fileId: string,
    localPath: string,
    options?: TransferOptions & { precondition?: string }
  ): Promise<CloudFile>;
  /** Creates a new child of `parentId` — used for sidecars and conflict copies. */
  create(
    parentId: string,
    name: string,
    localPath: string,
    options?: TransferOptions
  ): Promise<CloudFile>;
}

/** How a provider reads and writes its own credentials and account record. */
export interface ProviderStore {
  clientId(): string | undefined;
  clientSecret(): string | undefined;
  refreshToken(): string | undefined;
  setRefreshToken(value: string | undefined): Promise<void>;
  account(): CloudAccount | undefined;
  setAccount(value: CloudAccount | undefined): Promise<void>;
}

/**
 * Access-token lifecycle shared by all three providers: kept in memory only,
 * refreshed from the stored refresh token on demand, and refreshed exactly once
 * in response to a 401 before the failure is reported as an auth error.
 */
export abstract class OAuthProviderBase implements CloudProvider {
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  abstract readonly needsClientSecret: boolean;

  private token: TokenSet | undefined;

  constructor(protected readonly store: ProviderStore) {}

  protected abstract oauthConfig(clientId: string, clientSecret?: string): OAuthConfig;
  /** Reads the signed-in identity, so the menu can say who is connected. */
  protected abstract fetchAccount(): Promise<CloudAccount>;

  abstract list(folderId: string | undefined, pageToken?: string): Promise<ListPage>;
  abstract stat(fileId: string): Promise<CloudFile>;
  abstract findChild(parentId: string, name: string): Promise<CloudFile | undefined>;
  abstract download(file: CloudFile, destPath: string, options?: TransferOptions): Promise<void>;
  abstract upload(
    fileId: string,
    localPath: string,
    options?: TransferOptions & { precondition?: string }
  ): Promise<CloudFile>;
  abstract create(
    parentId: string,
    name: string,
    localPath: string,
    options?: TransferOptions
  ): Promise<CloudFile>;

  account(): CloudAccount | undefined {
    return this.store.account();
  }

  isConnected(): boolean {
    return this.store.refreshToken() !== undefined && this.store.account() !== undefined;
  }

  protected config(): OAuthConfig {
    const clientId = this.store.clientId();
    if (!clientId) {
      throw new CloudError(
        "noClient",
        `No ${this.label} client ID is configured. Set one under Settings ▸ Cloud Accounts.`
      );
    }
    return this.oauthConfig(clientId, this.store.clientSecret());
  }

  async connect(): Promise<CloudAccount> {
    const tokens = await runLoopbackAuth(this.config());
    if (!tokens.refreshToken) {
      // Without one we would silently need a browser round trip every hour.
      throw new CloudError(
        "auth",
        `${this.label} did not return a refresh token. Revoke KKSS's access in your ${this.label} ` +
          `account settings and connect again, so it prompts for consent.`
      );
    }
    this.token = tokens;
    await this.store.setRefreshToken(tokens.refreshToken);
    const account = await this.fetchAccount();
    await this.store.setAccount(account);
    return account;
  }

  async disconnect(): Promise<void> {
    this.token = undefined;
    await this.store.setRefreshToken(undefined);
    await this.store.setAccount(undefined);
  }

  /** A valid access token, refreshing when the cached one is spent. */
  protected async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.accessToken;
    const refreshToken = this.store.refreshToken();
    if (!refreshToken) {
      throw new CloudError("auth", `Not connected to ${this.label}.`);
    }
    const refreshed = await refreshTokens(this.config(), refreshToken);
    this.token = refreshed;
    // A provider that rotates refresh tokens hands back a new one; keeping the
    // old one would strand the account on its next launch.
    if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
      await this.store.setRefreshToken(refreshed.refreshToken);
    }
    return refreshed.accessToken;
  }

  /**
   * An authorized request, retried exactly once through a token refresh on a
   * 401. More than once would spin against a genuinely revoked grant.
   */
  protected async authed(
    url: string,
    init: RequestInit & { authorization?: false } = {}
  ): Promise<Response> {
    const send = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return this.send(url, { ...init, headers });
    };
    let response = await send(await this.accessToken());
    if (response.status === 401) {
      this.token = undefined;
      response = await send(await this.accessToken());
    }
    return response;
  }

  /** Unauthenticated request — Graph's pre-authenticated download URLs must
   *  NOT carry an Authorization header, or the CDN rejects them. */
  protected async send(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await net.fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new CloudError("network", `Could not reach ${this.label}: ${message(err)}`, err);
    }
  }

  /** Maps a failed response onto a CloudError kind the toast layer can branch on. */
  protected async fail(response: Response, what: string): Promise<never> {
    const body = await response.text().catch(() => "");
    const detail = body.slice(0, 300);
    const kind =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 404
          ? "notFound"
          : response.status === 409 || response.status === 412
            ? "conflict"
            : response.status === 429 || response.status === 507
              ? "quota"
              : "other";
    throw new CloudError(
      kind,
      `${this.label} ${what} failed (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
