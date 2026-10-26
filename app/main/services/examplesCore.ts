/**
 * Help ▸ Examples — the pure half: the case catalogue and the safe reading of a
 * tutorial zip. No `electron`, no `node:fs`, so `test/` imports it directly (the
 * `sessionCore.ts`/`session.ts` split). The zips are the same downloadable
 * archives the documentation links (`doc/public/examples/tutorials/<id>.zip`);
 * `esbuild.mjs` stages them into `out/examples/`.
 */
import { unzipSync } from "fflate";
import type { Message } from "../../shared/i18n";

export interface ExampleCase {
  id: string;
  /** i18n key (en.json) — the Help ▸ Examples label. */
  label: Message;
}

export const EXAMPLES: readonly ExampleCase[] = [
  { id: "structural", label: "Structural cantilever" },
  { id: "eigen", label: "Structural eigenmodes" },
  { id: "fluid", label: "Laminar flow around an obstacle" },
  { id: "rans", label: "Turbulent flow (RANS)" },
  { id: "thermal", label: "Stationary heat conduction" },
  { id: "potential-flow", label: "Uniform potential flow" },
  { id: "shallow-water", label: "Still-water basin" },
  { id: "fsi", label: "Fluid-structure interaction (Mok)" },
  { id: "cosim", label: "Partitioned coupling (CoSimulation)" },
  { id: "two-fluids", label: "Two-fluid dam break" },
  { id: "wind-tunnel", label: "Virtual wind tunnel" },
];

export const MAX_FILES = 500;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface ExamplePlan {
  /** Files to write, relative to the destination folder (always `<id>/…`). */
  files: Array<{ rel: string; data: Uint8Array }>;
  /** The relative path of the file to open: the geometry, else the mesh. */
  entry: string;
}

export function isExampleId(id: string): boolean {
  return EXAMPLES.some((e) => e.id === id);
}

/** A zip member name that stays inside `<id>/` — no `..`, no absolute or drive paths. */
export function safeMemberName(id: string, name: string): string | undefined {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return undefined;
  const parts = name.split("/");
  if (parts[0] !== id) return undefined;
  if (parts.some((p) => p === ".." || p === ".")) return undefined;
  return parts.join("/");
}

/** The document the tutorial starts from: its CAD geometry, else the generated mesh. */
export function pickEntry(names: readonly string[]): string | undefined {
  const geometry = names.find((n) => /\.(brep|stp|step)$/i.test(n));
  return geometry ?? names.find((n) => /(^|\/)mesh\.mdpa$/i.test(n));
}

/**
 * Validates a tutorial archive and decides what to write. Throws on anything
 * that is not exactly a `<id>/…` tree of plain files within the caps — a
 * traversal entry fails the whole example rather than being skipped, since an
 * archive that tries it is not the one KKSS shipped.
 */
export function planExample(id: string, zip: Uint8Array): ExamplePlan {
  if (!isExampleId(id)) throw new Error(`Unknown example "${id}".`);
  const entries = unzipSync(zip);
  const files: ExamplePlan["files"] = [];
  let total = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // a directory marker
    const rel = safeMemberName(id, name);
    if (!rel) throw new Error(`Unsafe path in the example archive: ${name}`);
    total += data.byteLength;
    if (files.length + 1 > MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error("The example archive is larger than expected.");
    files.push({ rel, data });
  }
  const entry = pickEntry(files.map((f) => f.rel));
  if (!entry) throw new Error("The example has no geometry or mesh to open.");
  return { files, entry };
}
