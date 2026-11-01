/**
 * Region (SubModelPart) references carried by a study's case settings, and what
 * happens to them when the attached mesh changes.
 *
 * Pure: no Electron, no filesystem — `service.ts` supplies the settings and the
 * mesh text. Everything here is **name matching only**: a region that
 * disappears and one that appears may be a rename or a delete plus an add, and
 * names cannot tell them apart (that needs CAD Part events, which do not exist
 * yet). So a suggested rename is only ever *offered*; applying one is a separate,
 * explicit, revision-bound edit.
 */
import type { Json } from './contracts';

export type ReferenceOwner = 'assignment' | 'material' | 'collection';
export interface RegionReference { owner: ReferenceOwner; label: string; path: string }
export type RegionStatus = 'kept' | 'lost';
export interface RegionRow { path: string; status: RegionStatus; references: { owner: ReferenceOwner; label: string }[]; possibleRename?: string }
export interface CarryOverReport {
  /** False when the mesh format has no text region listing; nothing is claimed then. */
  available: boolean;
  unavailableReason?: string;
  basis: 'name-only';
  regions: RegionRow[];
  /** Mesh regions no reference points at. */
  newRegions: string[];
  lost: number;
}

const object = (value: unknown): value is { [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every SubModelPart path the case settings point at, with the thing that points. */
export function collectReferences(caseSettings: Json | undefined): RegionReference[] {
  const found: RegionReference[] = [];
  if (!object(caseSettings)) return found;
  if (Array.isArray(caseSettings.assignments)) {
    for (const entry of caseSettings.assignments) {
      if (object(entry) && typeof entry.smpPath === 'string' && entry.smpPath) {
        found.push({ owner: 'assignment', label: typeof entry.conditionId === 'string' ? entry.conditionId : 'assignment', path: entry.smpPath });
      }
    }
  }
  if (Array.isArray(caseSettings.materials)) {
    for (const entry of caseSettings.materials) {
      if (object(entry) && typeof entry.smpPath === 'string' && entry.smpPath) {
        found.push({ owner: 'material', label: typeof entry.lawId === 'string' ? entry.lawId : 'material', path: entry.smpPath });
      }
    }
  }
  if (object(caseSettings.collections)) {
    for (const [collectionId, entries] of Object.entries(caseSettings.collections)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!object(entry) || !Array.isArray(entry.parts)) continue;
        for (const part of entry.parts) {
          if (typeof part === 'string' && part) found.push({ owner: 'collection', label: `${collectionId}/${typeof entry.name === 'string' ? entry.name : '?'}`, path: part });
        }
      }
    }
  }
  return found;
}

/**
 * Slash-joined SubModelPart paths of an MDPA text, parents included
 * (`Fluid`, `Fluid/Inlet`). A line scan of Begin/End SubModelPart; the block
 * bodies are never read, so it stays cheap on large meshes.
 */
export function listMdpaRegions(text: string): string[] {
  const out: string[] = [], stack: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('Begin') && !line.startsWith('End')) continue;
    const begin = /^Begin\s+SubModelPart\s+(\S+)/.exec(line);
    if (begin) { stack.push(begin[1]); out.push(stack.join('/')); continue; }
    if (/^End\s+SubModelPart\b/.test(line)) stack.pop();
  }
  return out;
}

const fold = (name: string): string => name.toLowerCase().replace(/[\s_\-.]+/g, '');

/** Compare what the settings reference with the regions the mesh now has. */
export function carryOverReport(references: RegionReference[], meshRegions: string[] | undefined, unavailableReason?: string): CarryOverReport {
  if (!meshRegions) return { available: false, unavailableReason: unavailableReason ?? 'The mesh format has no text region listing.', basis: 'name-only', regions: [], newRegions: [], lost: 0 };
  const present = new Set(meshRegions);
  const byPath = new Map<string, RegionReference[]>();
  for (const ref of references) byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), ref]);
  const referenced = new Set(byPath.keys());
  const newRegions = meshRegions.filter(path => !referenced.has(path));
  const claimed = new Set<string>();
  const regions: RegionRow[] = [...byPath.entries()].map(([path, refs]) => {
    const row: RegionRow = { path, status: present.has(path) ? 'kept' : 'lost', references: refs.map(({ owner, label }) => ({ owner, label })) };
    if (row.status === 'lost') {
      // Same leaf name under a different parent, or the same name modulo case/separators.
      const leaf = path.split('/').pop() ?? path;
      const candidates = newRegions.filter(n => !claimed.has(n) && (fold(n) === fold(path) || fold(n.split('/').pop() ?? n) === fold(leaf)));
      if (candidates.length === 1) { row.possibleRename = candidates[0]; claimed.add(candidates[0]); }
    }
    return row;
  });
  return { available: true, basis: 'name-only', regions, newRegions, lost: regions.filter(r => r.status === 'lost').length };
}

export interface RenameEntry { from: string; to: string }

/** `A` → `X` also moves `A/B` → `X/B`; anything else is untouched. */
export function renamePath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** A copy of the settings with every reference moved; the input is never mutated. */
export function applyRenames(caseSettings: Json, renames: RenameEntry[]): { settings: Json; changed: number } {
  const settings = JSON.parse(JSON.stringify(caseSettings)) as Json;
  let changed = 0;
  const move = (path: string): string => {
    let next = path;
    for (const { from, to } of renames) next = renamePath(next, from, to);
    if (next !== path) changed += 1;
    return next;
  };
  if (!object(settings)) return { settings, changed };
  for (const list of [settings.assignments, settings.materials]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (object(entry) && typeof entry.smpPath === 'string') entry.smpPath = move(entry.smpPath);
  }
  if (object(settings.collections)) {
    for (const entries of Object.values(settings.collections)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (object(entry) && Array.isArray(entry.parts)) entry.parts = entry.parts.map(part => typeof part === 'string' ? move(part) : part);
      }
    }
  }
  return { settings, changed };
}

/** Validates a user-supplied rename list; throws a message fit to show. */
export function parseRenames(value: unknown): RenameEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('renames must be a list of 1–100 {from, to} pairs.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!object(item as Json) || typeof (item as { from?: unknown }).from !== 'string' || typeof (item as { to?: unknown }).to !== 'string') throw new Error('Each rename needs string from and to.');
    const { from, to } = item as RenameEntry;
    if (!from || !to || from === to) throw new Error('A rename needs two different, non-empty paths.');
    if (/[\s]/.test(to) || to.startsWith('/') || to.endsWith('/') || to.includes('//')) throw new Error(`"${to}" is not a valid SubModelPart path.`);
    if (seen.has(from)) throw new Error(`"${from}" is renamed twice.`);
    seen.add(from);
    return { from, to };
  });
}
