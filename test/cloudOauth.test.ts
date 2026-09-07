/**
 * services/cloud/oauthCore.ts — PKCE, the CSRF state, and the loopback callback.
 *
 * The `state` check is the only thing standing between us and another page on
 * the machine driving the token exchange, so it is asserted before anything
 * else the callback carries.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildAuthUrl,
  createPkce,
  parseCallback,
  parseTokenResponse,
  randomState,
} from "../app/main/services/cloud/oauthCore";
import { CloudError } from "../app/main/services/cloud/cloudCore";

const fixed = (byte: number) => (size: number) => Buffer.alloc(size, byte);

describe("createPkce", () => {
  it("produces a base64url verifier of legal length", () => {
    const { verifier, method } = createPkce();
    expect(method).toBe("S256");
    // RFC 7636 §4.1: 43–128 characters from the unreserved set.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = createPkce(fixed(0x61));
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
    expect(challenge).not.toContain("=");
  });

  it("gives a different verifier every time", () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
    expect(randomState()).not.toBe(randomState());
  });
});

describe("buildAuthUrl", () => {
  it("encodes parameters and skips undefined ones", () => {
    const url = new URL(
      buildAuthUrl("https://example.test/auth", {
        client_id: "id 1",
        scope: "files.readwrite offline_access",
        prompt: undefined,
      })
    );
    expect(url.searchParams.get("client_id")).toBe("id 1");
    expect(url.searchParams.get("scope")).toBe("files.readwrite offline_access");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.toString()).toContain("scope=files.readwrite+offline_access");
  });
});

describe("parseCallback", () => {
  it("returns the code when the state matches", () => {
    expect(parseCallback("/callback?code=abc&state=s1", "s1")).toBe("abc");
  });

  it("rejects a mismatched or missing state before anything else", () => {
    expect(() => parseCallback("/callback?code=abc&state=other", "s1")).toThrow(CloudError);
    expect(() => parseCallback("/callback?code=abc", "s1")).toThrow(/did not match/);
    // Even a callback carrying a usable code is refused on a bad state.
    expect(() => parseCallback("/callback?code=abc&state=", "s1")).toThrow(/did not match/);
  });

  it("surfaces the provider's own error, description first", () => {
    expect(() =>
      parseCallback("/callback?state=s1&error=access_denied&error_description=User+said+no", "s1")
    ).toThrow(/User said no/);
    expect(() => parseCallback("/callback?state=s1&error=access_denied", "s1")).toThrow(
      /access_denied/
    );
  });

  it("fails cleanly on a callback with no code at all", () => {
    expect(() => parseCallback("/callback?state=s1", "s1")).toThrow(/no authorization code/);
  });

  it("reports auth as the error kind, so the toast can offer Connect", () => {
    try {
      parseCallback("/callback?state=nope", "s1");
      expect.unreachable();
    } catch (err) {
      expect((err as CloudError).kind).toBe("auth");
    }
  });
});

describe("parseTokenResponse", () => {
  const now = 1_000_000;

  it("expires a minute early so a long upload never starts on a dying token", () => {
    const set = parseTokenResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt" }, now);
    expect(set.accessToken).toBe("at");
    expect(set.refreshToken).toBe("rt");
    expect(set.expiresAt).toBe(now + (3600 - 60) * 1000);
  });

  it("defaults a missing lifetime and tolerates a refresh-less response", () => {
    // A refresh grant commonly returns no new refresh token.
    const set = parseTokenResponse({ access_token: "at" }, now);
    expect(set.expiresAt).toBe(now + (3600 - 60) * 1000);
    expect(set.refreshToken).toBeUndefined();
  });

  it("never returns a negative lifetime for a short-lived token", () => {
    expect(parseTokenResponse({ access_token: "at", expires_in: 10 }, now).expiresAt).toBe(now);
  });

  it("raises an auth error for an error body or a missing token", () => {
    expect(() =>
      parseTokenResponse({ error: "invalid_grant", error_description: "expired" }, now)
    ).toThrow(/expired/);
    expect(() => parseTokenResponse({}, now)).toThrow(/no access token/);
    expect(() => parseTokenResponse("nonsense", now)).toThrow(CloudError);
  });
});
