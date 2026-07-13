/**
 * API-key storage: safeStorage-encrypted values inside the stateStore
 * (userData/state.json). Thin Electron binding over the pure secretCodec.
 */
import { safeStorage } from "electron";
import { stateStore } from "../stateStore";
import { decodeSecret, encodeSecret } from "./secretCodec";

/** Stores (or clears, when value is empty) a secret under the given key. */
export async function setSecret(key: string, value: string): Promise<void> {
  await stateStore.update(key, value ? encodeSecret(safeStorage, value) : undefined);
}

export function getSecret(key: string): string | undefined {
  return decodeSecret(safeStorage, stateStore.get(key));
}

export function hasSecret(key: string): boolean {
  return getSecret(key) !== undefined;
}
