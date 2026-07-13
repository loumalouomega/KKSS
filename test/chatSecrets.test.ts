import { describe, expect, it } from "vitest";
import { decodeSecret, encodeSecret, SafeStorageLike } from "../app/main/services/chat/secretCodec";

/** XOR "encryption" — enough to prove the base64 round-trip. */
const fakeSafeStorage = (available: boolean): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(plain, "utf8").map((b) => b ^ 0x5a) as Buffer,
  decryptString: (enc) => Buffer.from(enc.map((b) => b ^ 0x5a)).toString("utf8"),
});

describe("secretCodec", () => {
  it("round-trips through encryption when the keyring is available", () => {
    const ss = fakeSafeStorage(true);
    const stored = encodeSecret(ss, "sk-ant-secret");
    expect(stored).toHaveProperty("enc");
    expect(JSON.stringify(stored)).not.toContain("sk-ant-secret");
    expect(decodeSecret(ss, stored)).toBe("sk-ant-secret");
  });

  it("falls back to plaintext without a keyring", () => {
    const ss = fakeSafeStorage(false);
    const stored = encodeSecret(ss, "key");
    expect(stored).toEqual({ plain: "key" });
    expect(decodeSecret(ss, stored)).toBe("key");
  });

  it("reads a plaintext value even when encryption is available now", () => {
    expect(decodeSecret(fakeSafeStorage(true), { plain: "old" })).toBe("old");
  });

  it("returns undefined on decrypt failure, missing, or malformed values", () => {
    const throwing: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => {
        throw new Error("keyring changed");
      },
    };
    expect(decodeSecret(throwing, { enc: "AAAA" })).toBeUndefined();
    expect(decodeSecret(throwing, undefined)).toBeUndefined();
    expect(decodeSecret(throwing, { other: 1 })).toBeUndefined();
    expect(decodeSecret(throwing, "raw-string")).toBeUndefined();
  });

  it("falls back to plaintext when encryptString itself throws", () => {
    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error("dbus down");
      },
      decryptString: () => "",
    };
    expect(encodeSecret(broken, "v")).toEqual({ plain: "v" });
  });
});
