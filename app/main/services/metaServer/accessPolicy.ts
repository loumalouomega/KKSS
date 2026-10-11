/**
 * Which tools the HTTP meta server will run for an external client.
 *
 * Pure — no `electron`, no `node:*` — so `test/` imports it directly. The
 * classification is the chat gate's (`toolPolicy.ts`), reused rather than
 * duplicated, but the *decision* differs: the chat prompts a human, whereas an
 * external client has nobody to prompt, so a call is either allowed or refused.
 *
 * - `readOnly` (the default for a newly enabled server): only `read` tools.
 * - `readListed`: `read` tools plus the write tools the user named.
 * - `all`: everything, as the server behaved before this setting existed.
 *
 * An `unknown` tool (no row in the table) is never a `read`, so it is refused
 * in the first two modes unless the user listed it by name.
 */
import { classifyTool } from "../chat/toolPolicy";

export type MetaAccess = "readOnly" | "readListed" | "all";

export const DEFAULT_META_ACCESS: MetaAccess = "readOnly";
/** stateStore flag: the one-time upgrade decision below has been taken. */
export const META_ACCESS_MIGRATED_KEY = "metaServerAccessMigrated";

export interface MetaAccessPolicy {
  access: MetaAccess;
  /** Tool names allowed in `readListed` mode (full namespaced names). */
  allowedWrites: ReadonlySet<string>;
}

export function isMetaAccess(value: unknown): value is MetaAccess {
  return value === "readOnly" || value === "readListed" || value === "all";
}

/** A hand-edited or corrupt value degrades to the safe default, never to `all`. */
export function readMetaAccess(value: unknown): MetaAccess {
  return isMetaAccess(value) ? value : DEFAULT_META_ACCESS;
}

export function normalizeAllowedWrites(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean));
}

export function metaToolAllowed(namespaced: string, policy: MetaAccessPolicy): boolean {
  if (policy.access === "all") return true;
  if (classifyTool(namespaced) === "read") return true;
  return policy.access === "readListed" && policy.allowedWrites.has(namespaced);
}

export function metaDenialText(namespaced: string, access: MetaAccess): string {
  const how = access === "readOnly" ? "only read-only tools are allowed" : "only read-only tools and the listed write tools are allowed";
  return `Tool ${namespaced} is not permitted: the KKSS MCP Server access setting is "${access}" (${how}). Change it under Settings ▸ MCP Server.`;
}

/**
 * The one-time upgrade decision. An install that already had the server
 * configured keeps behaving as before (`all`); a fresh install gets the safe
 * default. Returns the value to persist, or `undefined` for "leave it".
 * `alreadyDecided` is a separate flag because choosing the default value later
 * deletes the stored key, which would otherwise read as "never configured".
 */
export function metaAccessMigration(
  stored: unknown,
  hadPriorConfig: boolean,
  alreadyDecided: boolean
): MetaAccess | undefined {
  if (alreadyDecided || isMetaAccess(stored)) return undefined;
  return hadPriorConfig ? "all" : undefined;
}
