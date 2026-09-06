/**
 * Where a staged file lives on disk, and which of its neighbours are sidecars.
 * Pure: `node:crypto` and plain string work only, so `test/` imports it directly.
 *
 * Layout: `<userData>/cloud-cache/<provider>/<opaqueId>/<original filename>`.
 *
 * - **Deterministic** — reopening the same remote file reuses the directory,
 *   which is what makes its sidecars survive across sessions.
 * - **Opaque** — a Dropbox path or a Drive id containing `/`, `:` or `..` can
 *   never escape the cache root.
 * - **One directory holds exactly one document plus its sidecars.** That is
 *   what makes cad's `${modelPath}.parts.json` siblings land correctly with no
 *   cadHost change, and makes "every other non-artifact file here is a
 *   sidecar" a safe rule rather than a guess.
 * - **The filename is preserved byte-for-byte** wherever the OS allows it,
 *   because routing is extension-driven through mesh's longest-suffix
 *   `meshExtname` — `case.post.msh` must survive intact or it routes as Gmsh.
 */
import { createHash } from "node:crypto";
import { meshExtname, meshStem } from "../../../../mesh/src/parser/meshFormats";
import { CAD_SIDECAR_SUFFIXES, MACRO_LIBRARY_NAME, MESH_RUN_SIDECAR } from "../sidecarSuffixes";
import type { CloudRef, ProviderId } from "./cloudCore";

/** Stable per (account, item). 16 hex chars — collision-free in practice for a
 *  per-user cache, and short enough to keep paths well inside MAX_PATH.
 *  Length-prefixed rather than delimiter-joined: no separator is guaranteed
 *  absent from a provider's ids, and a collision would serve the wrong file. */
export function opaqueId(accountId: string, itemId: string): string {
  const input = `${accountId.length}:${accountId}:${itemId}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Control characters and the separators would let a remote name escape its
 *  staging directory; the rest Windows forbids outright. */
const ILLEGAL = /[\u0000-\u001F/\\:*?"<>|]/g;
const MAX_NAME_BYTES = 120;

/**
 * A remote name made safe as a single path segment, keeping the *full compound
 * suffix* when it has to be shortened.
 */
export function sanitizeFileName(name: string): string {
  let cleaned = name.replace(ILLEGAL, "_");
  // Windows silently strips trailing dots and spaces, which would desync the
  // name we think we wrote from the one actually on disk.
  cleaned = cleaned.replace(/[. ]+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  const stem = cleaned.slice(0, cleaned.length - suffixOf(cleaned).length);
  if (WINDOWS_RESERVED.test(stem)) cleaned = `_${cleaned}`;
  if (Buffer.byteLength(cleaned) <= MAX_NAME_BYTES) return cleaned;
  // Truncate the stem, never the suffix — the suffix is what routes the file.
  const suffix = suffixOf(cleaned);
  const budget = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(suffix));
  let truncated = cleaned.slice(0, cleaned.length - suffix.length);
  while (Buffer.byteLength(truncated) > budget) truncated = truncated.slice(0, -1);
  return `${truncated || "file"}${suffix}`;
}

/** The path's compound extension with its ORIGINAL case (meshExtname lowercases). */
export function suffixOf(name: string): string {
  const ext = meshExtname(name);
  return ext ? name.slice(name.length - ext.length) : "";
}

/** `<provider>/<opaqueId>/<safe name>` — relative to the cache root. */
export function cacheRelPath(ref: {
  provider: ProviderId;
  accountId: string;
  itemId: string;
  name: string;
}): string {
  return `${cacheDirRelPath(ref)}/${sanitizeFileName(ref.name)}`;
}

/** The staging directory (cache-root-relative) holding one document. */
export function cacheDirRelPath(ref: Pick<CloudRef, "provider" | "accountId" | "itemId">): string {
  return `${ref.provider}/${opaqueId(ref.accountId, ref.itemId)}`;
}

/**
 * Files the sync engine must never upload: our own atomic-write temp files
 * (`<name>.<pid>.tmp`), a download still in flight, and dotfiles.
 *
 * The `.tmp` rule is why the atomic-write change and this one belong together —
 * before it, a sidecar write produced no temp file at all.
 */
export function isStagingArtifact(name: string): boolean {
  return name.startsWith(".") || name.endsWith(".tmp") || name.endsWith(".download");
}

/**
 * Whether `candidate` is a sidecar of the staged document `modelName`.
 *
 * Deliberately excludes the macro library: `cad-preview-macros.json` is a per
 * *folder* library while the cache is per *file*, so uploading it would let two
 * models from one remote folder overwrite each other's macros. It stays local.
 */
export function isSidecarOf(modelName: string, candidate: string): boolean {
  if (candidate === modelName) return false;
  if (candidate === MACRO_LIBRARY_NAME) return false;
  if (CAD_SIDECAR_SUFFIXES.some((suffix) => candidate === `${modelName}${suffix}`)) return true;
  return candidate === `${meshStem(modelName)}${MESH_RUN_SIDECAR}`;
}

/** Every sidecar name `stage()` should look for beside a remote model. */
export function sidecarNamesFor(modelName: string): string[] {
  return [
    ...CAD_SIDECAR_SUFFIXES.map((suffix) => `${modelName}${suffix}`),
    `${meshStem(modelName)}${MESH_RUN_SIDECAR}`,
  ];
}
