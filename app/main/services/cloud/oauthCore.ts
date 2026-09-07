/**
 * The pure half of the OAuth flow: PKCE, the CSRF `state`, the authorization
 * URL, and parsing the loopback callback. The listener, the browser hand-off
 * and the token exchange are in oauth.ts.
 *
 * Randomness is injected so a test can pin a vector; the default is
 * `node:crypto` and nothing here ever logs a verifier, a code or a token.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { CloudError } from "./cloudCore";

export type RandomBytes = (size: number) => Buffer;

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636: a 43–128 char verifier, challenge = base64url(sha256(verifier)). */
export function createPkce(randomBytes: RandomBytes = nodeRandomBytes): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** 32 bytes of CSRF state, compared byte-for-byte on the callback. */
export function randomState(randomBytes: RandomBytes = nodeRandomBytes): string {
  return base64url(randomBytes(32));
}

export function buildAuthUrl(
  authEndpoint: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(authEndpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * The authorization code out of a loopback callback URL.
 *
 * Rejects a mismatched `state` before looking at anything else — that check is
 * the only thing standing between us and another page on the machine driving
 * the exchange.
 */
export function parseCallback(rawUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    throw new CloudError("auth", "The sign-in callback URL could not be read.");
  }
  const state = url.searchParams.get("state");
  if (!state || state !== expectedState) {
    throw new CloudError("auth", "Sign-in was rejected: the callback did not match this request.");
  }
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    throw new CloudError(
      "auth",
      description ? `Sign-in failed: ${description}` : `Sign-in failed: ${error}`
    );
  }
  const code = url.searchParams.get("code");
  if (!code) throw new CloudError("auth", "Sign-in returned no authorization code.");
  return code;
}

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshToken?: string;
}

/** All three providers answer the token endpoint in the same OAuth 2.0 shape. */
export function parseTokenResponse(raw: unknown, now: number): TokenSet {
  if (!raw || typeof raw !== "object") {
    throw new CloudError("auth", "The provider returned an unreadable token response.");
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.error === "string") {
    const description = typeof v.error_description === "string" ? v.error_description : v.error;
    throw new CloudError("auth", `Sign-in failed: ${description}`);
  }
  if (typeof v.access_token !== "string" || !v.access_token) {
    throw new CloudError("auth", "The provider returned no access token.");
  }
  // Expire a minute early so a request never starts on a token that dies
  // mid-flight; a refresh is cheap, a spurious 401 on a 3 GB upload is not.
  const lifetime = typeof v.expires_in === "number" ? v.expires_in : 3600;
  return {
    accessToken: v.access_token,
    expiresAt: now + Math.max(0, lifetime - 60) * 1000,
    refreshToken: typeof v.refresh_token === "string" ? v.refresh_token : undefined,
  };
}
