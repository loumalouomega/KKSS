/**
 * The folder-trust record for `.kkss/assistant/` — pure half.
 *
 * A project folder can supply definitions that make the assistant run a command
 * on the user's machine (an MCP server today; instructions, skills and hooks are
 * the roadmap's next items and reuse this record). Nothing of that kind loads
 * until the user trusts the folder, and trust is bound to a **hash of the
 * definition files**, so a later `git pull` that adds or edits one asks again.
 *
 * Keyed by the realpath of `projectRoot.explicit()` — never the inferred root —
 * the rule `discoverExternal()` already follows for `.kratos/problemtypes`.
 * The filesystem half is `userServerStore.ts`; this module only decides.
 */
import { createHash } from "node:crypto";

/** Directory (relative to the project root) whose files the trust record covers. */
export const ASSISTANT_DIR = ".kkss/assistant";
/**
 * What the trust hash covers, by relative name — the layout `assistantFiles.ts`
 * reads: `mcp.json`, `instructions.md`, `skills/<name>/SKILL.md` and
 * `prompts/<name>.md`. A new kind of definition means teaching that reader about
 * it; the hash, the prompt and the revoke path then need nothing else. Trusting a
 * folder trusts all of it at once, and an edit to any file asks again.
 */

export type TrustState = "none" | "untrusted" | "trusted" | "changed";

export interface TrustRecord { hash: string; at: number }
export type TrustStore = Record<string, TrustRecord>;

/** Hash of the present files, order-independent; null when there are none. */
export function hashDefinitions(files: Readonly<Record<string, string>>): string | null {
  const names = Object.keys(files).sort();
  if (!names.length) return null;
  const h = createHash("sha256");
  for (const name of names) {
    // Length-prefixed so ("a","bc") and ("ab","c") cannot collide.
    h.update(`${name.length}:${name}\0${Buffer.byteLength(files[name], "utf8")}:`);
    h.update(files[name]);
    h.update("\0");
  }
  return h.digest("hex");
}

export function parseTrustStore(raw: unknown): TrustStore {
  const out: TrustStore = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { hash, at } = value as { hash?: unknown; at?: unknown };
    if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) out[root] = { hash, at: typeof at === "number" ? at : 0 };
  }
  return out;
}

export function trustState(store: TrustStore, root: string, hash: string | null): TrustState {
  if (hash === null) return "none";
  const record = store[root];
  if (!record) return "untrusted";
  return record.hash === hash ? "trusted" : "changed";
}

export function withTrust(store: TrustStore, root: string, hash: string, at: number): TrustStore {
  return { ...store, [root]: { hash, at } };
}

export function withoutTrust(store: TrustStore, root: string): TrustStore {
  const next = { ...store };
  delete next[root];
  return next;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
