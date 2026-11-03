// Single-file project archive (roadmap item 7). Pure: bytes in, bytes/plans out.
// Layout: manifest.json + files/<project-relative path>. The zip is store-only,
// but the reader also accepts deflate members (third-party zips) under hard size caps.
import { createHash } from 'node:crypto';
import { inflateSync } from 'fflate';
import type { Project, Reference } from './contracts';
import { crc32, zipStore, textFile, type DiagnosticFile } from '../diagnosticsCore';

export interface ArchiveManifest {
  version: 1; projectId: string; generated: string; includesRuns: boolean;
  files: { path: string; sha256: string; bytes: number }[];
  /** References left outside the project; never packed, listed so the importer can offer relinking. */
  external: { owner: string; path: string }[];
}
export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Normalised, safe project-relative path or undefined (traversal, absolute, drive letters, NUL). */
export function safeRelative(p: string): string | undefined {
  if (!p || p.includes('\0') || p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return undefined;
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.some(s => s === '..' || s === '')) return undefined;
  return parts.join('/');
}

/** Every reference a project holds, tagged with its owner. Run references only when `includeRuns`. */
export function collectProjectReferences(project: Project, includeRuns: boolean): { owner: string; ref: Reference }[] {
  const out: { owner: string; ref: Reference }[] = [];
  for (const s of project.studies) {
    out.push({ owner: `${s.id}:source`, ref: s.source });
    if (s.mesh) out.push({ owner: `${s.id}:mesh`, ref: s.mesh });
    if (s.geometry) out.push({ owner: `${s.id}:baseSource`, ref: s.geometry.baseSource });
    if (s.handoff) for (const a of s.handoff.artifacts) out.push({ owner: `${s.id}:handoff`, ref: a.reference });
    if (includeRuns) for (const r of s.runs) for (const a of r.artifacts) out.push({ owner: `${s.id}:${r.id}:${a.role}`, ref: a.reference });
  }
  return out;
}

/** The project.json to ship: without runs the queue and runs are emptied and the queue is paused. */
export function packagedProject(project: Project, includeRuns: boolean): Project {
  const copy = structuredClone(project);
  copy.queue = { paused: true, tasks: includeRuns ? copy.queue.tasks : [] };
  delete copy.activeRunId;
  if (!includeRuns) for (const s of copy.studies) s.runs = [];
  return copy;
}

export function buildArchive(project: Project, files: { path: string; data: Uint8Array }[], external: ArchiveManifest['external'], includesRuns: boolean, generated: string): Uint8Array {
  const seen = new Set<string>(), entries: DiagnosticFile[] = [];
  for (const f of files) {
    const rel = safeRelative(f.path);
    if (!rel) throw new Error(`Unsafe project path: ${f.path}`);
    if (seen.has(rel)) continue;
    seen.add(rel);
    entries.push({ name: `files/${rel}`, data: f.data });
  }
  const manifest: ArchiveManifest = {
    version: 1, projectId: project.id, generated, includesRuns, external,
    files: files.filter((f, i) => files.findIndex(g => g.path === f.path) === i).map(f => ({ path: safeRelative(f.path)!, sha256: sha256(f.data), bytes: f.data.length })),
  };
  return zipStore([textFile('manifest.json', JSON.stringify(manifest, null, 2)), ...entries]);
}

export interface ZipLimits { maxMembers: number; maxTotalBytes: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxMembers: 20_000, maxTotalBytes: 2 * 1024 ** 3 };

export interface ZipRead {
  members: Map<string, Uint8Array>;
  /** Members whose names are traversal, absolute or drive-letter paths; never extracted. */
  unsafeMembers: string[];
}

/**
 * Read a zip (stored or deflate). Declared sizes are summed and capped BEFORE anything is
 * inflated, and each inflate is bounded to its declared size, so a lying header cannot
 * expand past the cap. Throws on other methods, encryption, zip64, bad CRCs and cap breaches.
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipRead {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Not a project archive (no zip directory).');
  const count = v.getUint16(end + 10, true);
  if (count > limits.maxMembers) throw new Error(`Archive holds more than ${limits.maxMembers} members.`);
  let at = v.getUint32(end + 16, true);
  interface Entry { name: string; method: number; crc: number; csize: number; size: number; local: number }
  const entries: Entry[] = [];
  let declared = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== 0x02014b50) throw new Error('Damaged archive directory.');
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true), crc = v.getUint32(at + 16, true);
    const csize = v.getUint32(at + 20, true), size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true), extra = v.getUint16(at + 30, true), comment = v.getUint16(at + 32, true), local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extra + comment;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`Archive member ${name} is encrypted.`);
    if (csize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error('Zip64 archives are not supported.');
    if (method !== 0 && method !== 8) throw new Error(`Archive member ${name} uses unsupported compression method ${method}.`);
    declared += size;
    if (declared > limits.maxTotalBytes) throw new Error('Archive expands beyond the size limit.');
    entries.push({ name, method, crc, csize, size, local });
  }
  const members = new Map<string, Uint8Array>(), unsafeMembers: string[] = [];
  for (const e of entries) {
    if (e.name !== 'manifest.json' && !(e.name.startsWith('files/') && safeRelative(e.name.slice(6)))) { unsafeMembers.push(e.name); continue; }
    if (e.local + 30 > bytes.length || v.getUint32(e.local, true) !== 0x04034b50) throw new Error(`Archive member ${e.name} is damaged.`);
    const lname = v.getUint16(e.local + 26, true), lextra = v.getUint16(e.local + 28, true), start = e.local + 30 + lname + lextra;
    const raw = bytes.subarray(start, start + e.csize);
    if (raw.length !== e.csize) throw new Error(`Archive member ${e.name} is damaged.`);
    let data: Uint8Array;
    if (e.method === 0) data = raw;
    else {
      try { data = inflateSync(raw, { out: new Uint8Array(e.size) }); } catch { throw new Error(`Archive member ${e.name} is damaged.`); }
    }
    if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`Archive member ${e.name} is damaged.`);
    members.set(e.name, data);
  }
  return { members, unsafeMembers };
}

/** Back-compat wrapper returning only the safe members. */
export const readStoreZip = (bytes: Uint8Array): Map<string, Uint8Array> => readZip(bytes).members;

export interface UnresolvedExternal {
  path: string; owner: string; studyId: string; role: string;
  /** Source references can be repointed with app__study_relink_source; other roles are listed only. */
  relink: 'app__study_relink_source' | null;
}

/** External references not present on this machine, split into study and role. Pure; `exists` is injected. */
export function unresolvedExternal(manifest: ArchiveManifest, exists: (absPath: string) => boolean): UnresolvedExternal[] {
  const out: UnresolvedExternal[] = [];
  for (const e of Array.isArray(manifest.external) ? manifest.external : []) {
    if (typeof e?.path !== 'string' || typeof e.owner !== 'string' || exists(e.path)) continue;
    const i = e.owner.indexOf(':');
    const studyId = i < 0 ? e.owner : e.owner.slice(0, i), role = i < 0 ? '' : e.owner.slice(i + 1);
    out.push({ path: e.path, owner: e.owner, studyId, role, relink: role === 'source' ? 'app__study_relink_source' : null });
  }
  return out;
}

export interface UnpackPlan {
  manifest: ArchiveManifest;
  files: { path: string; data: Uint8Array }[];
  /** Problems per path; a damaged or missing file is skipped, never fatal to the rest. */
  problems: { path: string; problem: 'missing' | 'damaged' | 'unsafe' }[];
  /** Existing destination paths: unpacking must not run until the caller resolves them. */
  conflicts: string[];
}

export function planUnpack(members: Map<string, Uint8Array>, exists: (rel: string) => boolean): UnpackPlan {
  const raw = members.get('manifest.json');
  if (!raw) throw new Error('Not a project archive (manifest.json missing).');
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as ArchiveManifest;
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported archive version.');
  const files: UnpackPlan['files'] = [], problems: UnpackPlan['problems'] = [], conflicts: string[] = [];
  for (const entry of manifest.files) {
    const rel = typeof entry.path === 'string' ? safeRelative(entry.path) : undefined;
    if (!rel) { problems.push({ path: String(entry.path), problem: 'unsafe' }); continue; }
    const data = members.get(`files/${rel}`);
    if (!data) { problems.push({ path: rel, problem: 'missing' }); continue; }
    if (sha256(data) !== entry.sha256) { problems.push({ path: rel, problem: 'damaged' }); continue; }
    files.push({ path: rel, data });
    if (exists(rel)) conflicts.push(rel);
  }
  return { manifest, files, problems, conflicts };
}
