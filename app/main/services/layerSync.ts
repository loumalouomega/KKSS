/**
 * Bidirectional layer sync between pre (CAD) and post (mesh) modes.
 *
 * The two models are deliberately different upstream and stay that way:
 * - CAD (`<model>.layers.json`): `Layer` with `layer-N` ids, `volumes`/
 *   `surfaces`/`lines`/`points` entity-id bags, CSS-hex colour, persisted
 *   visibility + lock (a locked entity refuses as an edit operand).
 * - Mesh (`<stem>.kratosview.json`): `UserLayer` with slug ids, `blocks` +
 *   `parts` paths + explicit numeric `ids`, RGB 0..1 colour, view-only
 *   (never solver data, never dirty).
 *
 * Entity membership lives in incompatible id spaces (B-rep `solid-N`/`face-N`
 * vs element/condition/geometry numbers vs `node-N` view ids), so membership
 * is NEVER translated — only structure (name, colour, visibility, lock).
 * A translated layer arrives with empty membership and a warning saying so;
 * the user assigns members on that side. Merge is union-only (add + update
 * presentation fields, never delete), so repeated syncs converge instead of
 * ping-ponging.
 *
 * Pure except for the thin `syncFilePair` fs helper at the bottom, which
 * index.ts calls on open/export/focus transitions (last-writer-wins by
 * mtime). No watcher: a continuous two-way watcher would rewrite a sidecar
 * while its own panel edits it.
 */
import * as fs from "node:fs";
import {
  allocateLayerId,
  layersWithDefault,
  parseLayersFile,
  serializeLayersJson,
  type LayerDrawSubset,
} from "../../../cad/src/layersSidecar";
import type { Layer } from "../../../cad/src/protocol";
import { viewFilePath } from "../../../mesh/src/problemtype/caseFile";
import {
  layerColorToHex,
  newLayerId,
  parseLayerColor,
  parseViewSidecar,
  serializeViewSidecar,
  validateUserLayers,
  type UserLayer,
} from "../../../mesh/src/parser/userLayers";

export interface LayerSyncReport {
  created: string[];
  updated: string[];
  warnings: string[];
}

const MESH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** CAD `#rrggbb` → mesh RGB 0..1, or undefined when malformed. */
export function cadColorToRgb(hex: string): [number, number, number] | undefined {
  return parseLayerColor(hex);
}

/** Mesh RGB 0..1 → CAD `#rrggbb`. */
export function rgbToCadColor(c: readonly [number, number, number]): string {
  return layerColorToHex([c[0], c[1], c[2]]);
}

/**
 * A CAD name made usable as a mesh layer name (mesh forbids `/`, caps at 120
 * chars, requires non-empty). Lossy by construction; the original survives on
 * the CAD side and the rename is reported.
 */
export function sanitizeMeshName(name: string): string {
  const t = name.replace(/\//g, "-").trim().slice(0, 120);
  return t.length > 0 ? t : "Layer";
}

function uniqueMeshName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

function sameColor(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Translates CAD layers into mesh user layers, merged over `existing` (which
 * is never mutated). Matched layers (by id, else by name) keep their mesh
 * membership and gain the CAD presentation fields; new layers arrive empty.
 */
export function cadToViewLayers(
  cadLayers: readonly Layer[],
  existing: readonly UserLayer[]
): { layers: UserLayer[]; report: LayerSyncReport } {
  const report: LayerSyncReport = { created: [], updated: [], warnings: [] };
  const merged: UserLayer[] = existing.map((l) => ({
    ...l,
    color: [...l.color] as [number, number, number],
    blocks: [...l.blocks],
    parts: [...l.parts],
    ids: { Elements: [...l.ids.Elements], Conditions: [...l.ids.Conditions], Geometries: [...l.ids.Geometries] },
  }));
  const byId = new Map(merged.map((l) => [l.id, l]));
  const takenNames = new Set(merged.map((l) => l.name));
  const takenIds = new Set(merged.map((l) => l.id));
  let paletteIndex = merged.length;

  for (const cad of layersWithDefault(cadLayers)) {
    // The CAD default layer is implicit (unassigned entities live there) and
    // mesh has no default concept — syncing it would materialize a noise
    // "Default" layer on every post file. Real user layers sync; layer-0 never
    // does (its members cannot translate across the id-space gap anyway).
    if (cad.id === "layer-0") continue;
    const rgb = cadColorToRgb(cad.color);
    const color: [number, number, number] = rgb ?? [0.55, 0.55, 0.55];
    if (!rgb) report.warnings.push(`Layer "${cad.name}": unparseable colour "${cad.color}" reset to grey.`);
    const direct = byId.get(cad.id);
    const byName = direct ?? merged.find((l) => l.name === sanitizeMeshName(cad.name));
    if (byName) {
      if (!sameColor(byName.color, color) || byName.visible !== cad.visible || byName.locked !== cad.locked) {
        byName.color = color;
        byName.visible = cad.visible;
        byName.locked = cad.locked;
        report.updated.push(byName.name);
      }
      continue;
    }
    const name = uniqueMeshName(sanitizeMeshName(cad.name), takenNames);
    if (name !== cad.name) report.warnings.push(`Layer "${cad.name}" renamed to "${name}" (mesh names cannot contain "/").`);
    const id = MESH_ID_RE.test(cad.id) && !takenIds.has(cad.id) ? cad.id : newLayerId(name, [...takenIds]);
    const layer: UserLayer = {
      id,
      name,
      color,
      visible: cad.visible,
      locked: cad.locked,
      blocks: [],
      parts: [],
      ids: { Elements: [], Conditions: [], Geometries: [] },
    };
    void paletteIndex;
    takenNames.add(name);
    takenIds.add(id);
    byId.set(id, layer);
    merged.push(layer);
    report.created.push(name);
  }
  if (report.created.length > 0 || report.updated.length > 0) {
    report.warnings.push(
      "Membership is not translated between pre and post (B-rep entity ids and mesh element ids live in different spaces) — synced layers arrive empty; assign their members on this side."
    );
  }
  return { layers: merged, report };
}

/**
 * Translates mesh user layers into CAD layers, merged over `existing` (never
 * mutated). Matched layers keep their CAD membership and gain the mesh
 * presentation fields; new layers arrive empty with freshly allocated
 * never-reused `layer-N` ids. Returns the updated `nextId` counter, which the
 * caller must persist alongside the list.
 */
export function viewToCadLayers(
  viewLayers: readonly UserLayer[],
  existing: readonly Layer[],
  nextId: number
): { layers: Layer[]; nextId: number; report: LayerSyncReport } {
  const report: LayerSyncReport = { created: [], updated: [], warnings: [] };
  const full = layersWithDefault(existing);
  const merged: Layer[] = full.map((l) => ({
    ...l,
    volumes: [...l.volumes],
    surfaces: [...l.surfaces],
    lines: [...l.lines],
    points: [...l.points],
  }));
  // Materialize the implicit default so a first synced layer lands beside it
  // instead of colliding with its id.
  const base: Layer[] = existing.length === 0 ? merged : merged;
  void base;
  const byId = new Map(merged.map((l) => [l.id, l]));
  let counter = nextId;

  for (const view of viewLayers) {
    const color = rgbToCadColor(view.color);
    const direct = byId.get(view.id);
    const byName = direct ?? merged.find((l) => l.name === view.name);
    if (byName) {
      if (byName.color.toLowerCase() !== color.toLowerCase() || byName.visible !== view.visible || byName.locked !== view.locked) {
        byName.color = color;
        byName.visible = view.visible;
        byName.locked = view.locked;
        report.updated.push(byName.name);
      }
      continue;
    }
    const alloc = allocateLayerId(merged, counter);
    counter = alloc.nextId;
    const layer: Layer = {
      id: view.id.match(/^layer-\d+$/) && !byId.has(view.id) ? view.id : alloc.id,
      name: view.name,
      color,
      visible: view.visible,
      locked: view.locked,
      volumes: [],
      surfaces: [],
      lines: [],
      points: [],
    };
    if (layer.id !== view.id) {
      // allocateLayerId already consumed a counter value for the fallback id
      // even when the slug was reusable — harmless (the counter only grows).
    }
    byId.set(layer.id, layer);
    merged.push(layer);
    report.created.push(layer.name);
  }
  if (report.created.length > 0 || report.updated.length > 0) {
    report.warnings.push(
      "Membership is not translated between post and pre (mesh blocks/parts/element ids have no B-rep counterpart) — synced layers arrive empty; assign their members on this side. Lock meaning differs: in pre it refuses edit operands, in post it only pins the layer row."
    );
  }
  return { layers: merged, nextId: counter, report };
}

/** Read a CAD layers sidecar; missing/unreadable → empty. */
export function readCadLayersFile(modelPath: string): { layers: Layer[]; nextId: number } {
  try {
    return parseLayersFile(fs.readFileSync(`${modelPath}.layers.json`, "utf8"));
  } catch {
    return { layers: [], nextId: 0 };
  }
}

/** Read a mesh view sidecar; missing/unreadable → empty (warnings dropped). */
export function readViewLayersFile(meshPath: string): UserLayer[] {
  try {
    return parseViewSidecar(fs.readFileSync(viewFilePath(meshPath), "utf8")).layers;
  } catch {
    return [];
  }
}

function mtimeOrNull(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Syncs the two layer sidecars beside `cadPath` (pre) and `meshPath` (post).
 * When both hold the same file (shared `.stl`/`.obj`/`.ply`), pass it twice.
 * Direction is last-writer-wins by sidecar mtime; a missing sidecar is never
 * created from nothing (an absent layers file means "no layers yet", not
 * "delete them elsewhere"). Returns a human-readable summary, or null when
 * there was nothing to do. Never throws — IO failures become warnings.
 */
export function syncFilePair(cadPath: string, meshPath: string): string | null {
  let cadFile: { layers: Layer[]; nextId: number };
  let viewLayers: UserLayer[];
  try {
    cadFile = readCadLayersFile(cadPath);
  } catch (err) {
    return `Layer sync skipped: could not read the pre layers (${err instanceof Error ? err.message : String(err)}).`;
  }
  try {
    const raw = fs.readFileSync(viewFilePath(meshPath), "utf8");
    viewLayers = validateUserLayers(parseViewSidecar(raw).layers).layers;
  } catch {
    viewLayers = [];
  }
  const cadSidecar = `${cadPath}.layers.json`;
  const viewSidecar = viewFilePath(meshPath);
  const cadMtime = cadFile.layers.length > 0 ? mtimeOrNull(cadSidecar) : null;
  const viewMtime = viewLayers.length > 0 ? mtimeOrNull(viewSidecar) : null;
  if (cadMtime === null && viewMtime === null) return null;

  try {
    if (viewMtime === null || (cadMtime !== null && cadMtime >= (viewMtime ?? 0))) {
      // Pre wins: merge CAD structure into the post sidecar.
      const { layers, report } = cadToViewLayers(cadFile.layers, viewLayers);
      if (report.created.length === 0 && report.updated.length === 0) return null;
      fs.writeFileSync(viewSidecar, serializeViewSidecar(layers));
      return describeReport("pre → post", report);
    }
    // Post wins: merge mesh structure into the pre sidecar.
    const { layers, nextId, report } = viewToCadLayers(viewLayers, cadFile.layers, cadFile.nextId);
    if (report.created.length === 0 && report.updated.length === 0) return null;
    const sourceName = cadPath.slice(cadPath.lastIndexOf("/") + 1) || cadPath;
    fs.writeFileSync(cadSidecar, serializeLayersJson(sourceName, layers, nextId));
    return describeReport("post → pre", report);
  } catch (err) {
    return `Layer sync skipped: could not write the synced sidecar (${err instanceof Error ? err.message : String(err)}).`;
  }
}

function describeReport(direction: string, report: LayerSyncReport): string {
  const bits: string[] = [];
  if (report.created.length > 0) bits.push(`created ${report.created.length}: ${report.created.join(", ")}`);
  if (report.updated.length > 0) bits.push(`updated ${report.updated.length}: ${report.updated.join(", ")}`);
  return `Layers synced ${direction} — ${bits.join("; ")}.`;
}

export type { LayerDrawSubset };
