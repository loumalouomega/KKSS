/**
 * Recovery checkpoints: the filesystem glue over `recoveryCore.ts`.
 *
 * A live session writes checkpoints for work that exists nowhere else — a
 * dirty mesh tab's operation recipe, a dirty editor buffer — into its own
 * `<root>/<pid>-<start>/` folder, and removes that folder on a clean close.
 * A folder whose owner is gone (crash, power loss, SIGKILL) is an orphan and
 * is *offered* on the next launch; nothing here ever applies one. Entries stay
 * until the user decides (restore / discard), so declining today does not
 * cost the work tomorrow.
 *
 * Electron-free (the root is injected) so `test/recovery.test.ts` drives it
 * against a real temp directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicSync } from "./atomicWrite";
import {
  RECOVERY_EDITOR_MAX_BYTES, RECOVERY_VERSION, capEntries, isOrphanSession, parseEntry,
  parseLegacyEditor, parseLegacyMesh, parseSessionDirName, sessionDirName,
  type ListedRecovery, type RecoveryEntry, type SessionStamp,
} from "./recoveryCore";

/** `null` = no such process; "unknown" = alive but its start time is unreadable. */
export type LiveStartReader = (pid: number) => number | null | "unknown";

/** Linux reads /proc; elsewhere a live pid reports "unknown" (kept, not deleted). */
export function readLiveStartSeconds(pid: number): number | null | "unknown" {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" ? "unknown" : null; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) may contain spaces and parentheses: split after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]); // field 22 overall; fields[0] is field 3
    const btime = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    if (!Number.isFinite(ticks) || !btime) return "unknown";
    return Math.floor(Number(btime[1]) + ticks / 100);
  } catch { return "unknown"; }
}

export interface RecoveryOptions {
  pid?: number;
  /** Override the live-process lookup (tests). */
  liveStart?: LiveStartReader;
  now?: () => number;
}

export class RecoveryService {
  private readonly stamp: SessionStamp;
  private readonly liveStart: LiveStartReader;
  private readonly now: () => number;
  readonly sessionDirectory: string;
  private disposed = false;

  constructor(readonly root: string, options: RecoveryOptions = {}) {
    const pid = options.pid ?? process.pid;
    this.liveStart = options.liveStart ?? readLiveStartSeconds;
    this.now = options.now ?? Date.now;
    const own = options.pid === undefined ? readLiveStartSeconds(pid) : this.liveStart(pid);
    const startSeconds = typeof own === "number" ? own : Math.floor(this.now() / 1000 - process.uptime());
    this.stamp = { pid, startSeconds: Math.max(1, startSeconds) };
    this.sessionDirectory = path.join(root, sessionDirName(this.stamp));
  }

  private async ensureSession(): Promise<void> {
    await fs.promises.mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path.join(this.sessionDirectory, "session.json"), JSON.stringify({ version: RECOVERY_VERSION, ...this.stamp }));
  }

  private entryPath(id: string): string { return path.join(this.sessionDirectory, `${id}.json`); }
  private recipePath(id: string): string { return path.join(this.sessionDirectory, `${id}.ops.json`); }

  /** Stat the document a checkpoint is written against (null when unreadable). */
  private async stampSource(file: string | null): Promise<{ sourceMtimeMs: number | null; sourceSize: number | null }> {
    if (!file) return { sourceMtimeMs: null, sourceSize: null };
    try { const s = await fs.promises.stat(file); return { sourceMtimeMs: s.mtimeMs, sourceSize: s.size }; }
    catch { return { sourceMtimeMs: null, sourceSize: null }; }
  }

  /**
   * One live checkpoint per `id`. `writeRecipe` is the provider's own
   * `backupCustomDocument` bound to the destination; it may refuse (a preview
   * that has not loaded its mesh yet), in which case nothing is recorded and
   * the previous checkpoint, if any, stands.
   */
  async checkpointMesh(id: string, originalPath: string, writeRecipe: (destination: string) => Promise<void>, task?: string): Promise<boolean> {
    if (this.disposed) return false;
    await this.ensureSession();
    const recipe = this.recipePath(id);
    await writeRecipe(recipe);
    const entry: RecoveryEntry = {
      version: RECOVERY_VERSION, id, kind: "mesh", originalPath,
      recipeFile: path.basename(recipe), savedAt: this.now(),
      ...(await this.stampSource(originalPath)), ...(task ? { task } : {}),
    };
    await writeFileAtomic(this.entryPath(id), JSON.stringify(entry));
    return true;
  }

  async checkpointEditor(id: string, originalPath: string | null, content: string, task?: string): Promise<boolean> {
    if (this.disposed || Buffer.byteLength(content, "utf8") > RECOVERY_EDITOR_MAX_BYTES) return false;
    await this.ensureSession();
    const entry: RecoveryEntry = {
      version: RECOVERY_VERSION, id, kind: "editor", originalPath, content, savedAt: this.now(),
      ...(await this.stampSource(originalPath)), ...(task ? { task } : {}),
    };
    await writeFileAtomic(this.entryPath(id), JSON.stringify(entry));
    return true;
  }

  /** The work was saved or deliberately discarded: drop this session's checkpoint. */
  async clear(id: string): Promise<void> {
    await Promise.all([this.entryPath(id), this.recipePath(id)].map(file => fs.promises.rm(file, { force: true })));
  }

  /**
   * Clean close: the session's own folder goes, but only checkpoints the user
   * never resolved would be worth keeping — and those are re-written by the
   * quit path's `saveForShutdown` as flat files before this runs. Sync because
   * `will-quit` cannot await.
   */
  dispose(): void {
    this.disposed = true;
    try { fs.rmSync(this.sessionDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  /** Quit-path write of a flat entry (same shape, no session ownership). */
  writeFlatEditorSync(entry: Extract<RecoveryEntry, { kind: "editor" }>): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(path.join(this.root, `${entry.id}.json`), JSON.stringify(entry));
  }

  /**
   * Orphans only: entries from sessions whose owner is gone, plus legacy flat
   * files. A live session's folder (including this one's) is never listed, and
   * a folder that is orphaned but unreadable is skipped, not deleted.
   */
  async list(): Promise<ListedRecovery[]> {
    const found: ListedRecovery[] = [];
    let names: fs.Dirent[];
    try { names = await fs.promises.readdir(this.root, { withFileTypes: true }); }
    catch { return []; }
    for (const dirent of names) {
      const full = path.join(this.root, dirent.name);
      if (dirent.isDirectory()) {
        const stamp = parseSessionDirName(dirent.name);
        if (!stamp || dirent.name === sessionDirName(this.stamp)) continue;
        if (!isOrphanSession(stamp, this.liveStart)) continue;
        for (const file of await this.safeReaddir(full)) {
          if (!file.endsWith(".json") || file === "session.json" || file.endsWith(".ops.json")) continue;
          const entry = parseEntry(await this.readJson(path.join(full, file)));
          if (!entry) continue;
          found.push({ entry, directory: full, files: entry.kind === "mesh" ? [file, entry.recipeFile] : [file] });
        }
      } else if (dirent.isFile()) {
        const legacy = await this.parseFlat(full, dirent.name);
        if (legacy) found.push(legacy);
      }
    }
    const { kept, dropped } = capEntries(found);
    for (const gone of dropped) await this.discard(gone);
    return kept;
  }

  private async parseFlat(full: string, name: string): Promise<ListedRecovery | null> {
    const savedAt = await fs.promises.stat(full).then(s => s.mtimeMs, () => 0);
    if (/^editor-.*\.json$/.test(name)) {
      const entry = parseLegacyEditor(name, await this.readJson(full), savedAt);
      return entry ? { entry, directory: this.root, files: [name] } : null;
    }
    if (/^mesh-.*\.json\.source\.json$/.test(name)) {
      const entry = parseLegacyMesh(name, await this.readJson(full), savedAt);
      // The recipe itself must still be there; a source note without it is nothing to restore.
      if (!entry || entry.kind !== "mesh" || !fs.existsSync(path.join(this.root, entry.recipeFile))) return null;
      return { entry, directory: this.root, files: [name, entry.recipeFile] };
    }
    return null;
  }

  private async safeReaddir(dir: string): Promise<string[]> {
    try { return await fs.promises.readdir(dir); } catch { return []; }
  }

  private async readJson(file: string): Promise<unknown> {
    try { return JSON.parse(await fs.promises.readFile(file, "utf8")); } catch { return null; }
  }

  /** Absolute path of a mesh entry's recipe. */
  recipeFileOf(listed: ListedRecovery): string | null {
    return listed.entry.kind === "mesh" ? path.join(listed.directory, listed.entry.recipeFile) : null;
  }

  /** The user decided: remove the entry's files, and its folder once empty. */
  async discard(listed: ListedRecovery): Promise<void> {
    await Promise.all(listed.files.map(f => fs.promises.rm(path.join(listed.directory, f), { force: true })));
    if (listed.directory === this.root) return;
    const left = (await this.safeReaddir(listed.directory)).filter(f => f !== "session.json");
    if (left.length === 0) await fs.promises.rm(listed.directory, { recursive: true, force: true });
  }
}
