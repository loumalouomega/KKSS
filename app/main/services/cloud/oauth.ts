/**
 * The browser half of the OAuth flow: a one-shot loopback listener, the consent
 * hand-off through the user's real browser, and the token exchange/refresh.
 *
 * Shape copied deliberately from services/metaServer/metaServer.ts's `enable()`
 * — `server.once("error")` registered *before* `listen(port, "127.0.0.1")`, the
 * bound port read back from `server.address()`, and the same Host-header check
 * that defeats DNS rebinding. A bind failure surfaces as a rejected promise
 * (and a toast) instead of a hang.
 *
 * Security properties this file is responsible for, none of which the type
 * system enforces:
 *
 * - binds 127.0.0.1 only, never 0.0.0.0;
 * - validates the CSRF `state` before acting on the callback (oauthCore);
 * - validates the `Host` header;
 * - closes after **exactly one** callback, or a 2-minute timeout;
 * - answers with a fixed page that reflects nothing from the query string;
 * - never logs a code, a verifier or a token.
 *
 * **No KKSS-owned client id is ever baked in.** The user supplies their own
 * under Settings ▸ Cloud Accounts, which is why `clientId` is a required field
 * here rather than a constant.
 */
import * as http from "node:http";
import { net, shell } from "electron";
import { CloudError } from "./cloudCore";
import {
  buildAuthUrl,
  createPkce,
  parseCallback,
  parseTokenResponse,
  randomState,
  type TokenSet,
} from "./oauthCore";

export interface OAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  /**
   * Only Google issues one for a "Desktop app" client, and its own installed-app
   * documentation says it is not treated as confidential. We still store it
   * through chat/secrets.ts rather than in the clear.
   */
  clientSecret?: string;
  /**
   * Dropbox's console requires an *exact* registered redirect URI, so its
   * provider pins a port; Google and Microsoft accept a loopback redirect on
   * any port, so they pass 0 and take whatever the OS gives.
   */
  redirectPort?: number;
  /** Drive needs access_type=offline&prompt=consent to get a refresh token. */
  extraAuthParams?: Record<string, string>;
}

const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 120_000;

const DONE_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>KKSS</title>` +
  `<body style="font:14px system-ui;margin:3rem;text-align:center">` +
  `<p>${message}</p><p>You can close this tab and return to KKSS.</p></body>`;

/**
 * Runs the full authorization-code + PKCE flow and returns the token set.
 * Resolves only after the browser has come back to our loopback listener.
 */
export async function runLoopbackAuth(config: OAuthConfig): Promise<TokenSet> {
  const pkce = createPkce();
  const state = randomState();
  const server = http.createServer();

  const port = await listen(server, config.redirectPort ?? 0);
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  try {
    const codePromise = awaitCallback(server, port, state);
    await shell.openExternal(
      buildAuthUrl(config.authUrl, {
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: config.scopes.join(" "),
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        ...config.extraAuthParams,
      })
    );
    const code = await codePromise;
    return await exchange(config, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    });
  } finally {
    await close(server);
  }
}

/** Trades a stored refresh token for a fresh access token. */
export function refreshTokens(config: OAuthConfig, refreshToken: string): Promise<TokenSet> {
  return exchange(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) =>
      reject(
        new CloudError(
          "other",
          port === 0
            ? `Could not open a local port for sign-in: ${err.message}`
            : `Could not open port ${port} for sign-in — it may already be in use. ${err.message}`,
          err
        )
      );
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

/** Resolves with the authorization code from the first well-formed callback. */
function awaitCallback(server: http.Server, port: number, state: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeListener("request", onRequest);
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new CloudError("auth", "Sign-in timed out — no response from the browser."))),
      CALLBACK_TIMEOUT_MS
    );

    const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url ?? "";
      // Host must be our own loopback address, or a page on another origin
      // could drive this listener via DNS rebinding.
      const host = (req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403).end();
        return;
      }
      if (!url.startsWith(CALLBACK_PATH)) {
        res.writeHead(404).end();
        return;
      }
      // The response body is fixed text — it never echoes the query string.
      try {
        const code = parseCallback(url, state);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE("Signed in."));
        finish(() => resolve(code));
      } catch (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(DONE_PAGE("Sign-in failed."));
        finish(() => reject(err));
      }
    };

    server.on("request", onRequest);
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function exchange(config: OAuthConfig, body: Record<string, string>): Promise<TokenSet> {
  const form = new URLSearchParams({ ...body, client_id: config.clientId });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);

  let response: Response;
  try {
    // net.fetch is the house style for main-process outbound (services/updates.ts).
    response = await net.fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CloudError("network", `Could not reach the sign-in service: ${describe(err)}`, err);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CloudError("auth", `The sign-in service returned ${response.status}.`);
  }
  // parseTokenResponse surfaces the provider's own error body, which is far
  // more actionable than the status code (invalid_client vs invalid_grant).
  return parseTokenResponse(payload, Date.now());
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
