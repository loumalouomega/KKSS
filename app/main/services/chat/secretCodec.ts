/**
 * Encoding/decoding of secrets stored in the stateStore. Pure module — the
 * safeStorage implementation is injected so tests run without Electron.
 * Encrypted values are kept as base64; when the OS provides no keyring the
 * value falls back to plaintext (documented behavior, matching the rest of
 * state.json).
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type StoredSecret = { enc: string } | { plain: string };

export function encodeSecret(safeStorage: SafeStorageLike, value: string): StoredSecret {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(value).toString("base64") };
    }
  } catch {
    /* fall through to plaintext */
  }
  return { plain: value };
}

export function decodeSecret(safeStorage: SafeStorageLike, stored: unknown): string | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  if ("plain" in stored && typeof (stored as { plain: unknown }).plain === "string") {
    return (stored as { plain: string }).plain;
  }
  if ("enc" in stored && typeof (stored as { enc: unknown }).enc === "string") {
    try {
      return safeStorage.decryptString(Buffer.from((stored as { enc: string }).enc, "base64"));
    } catch {
      return undefined; // keyring changed or value corrupted
    }
  }
  return undefined;
}
