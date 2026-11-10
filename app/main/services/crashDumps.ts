import { app, crashReporter } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDumpName, selectDumps, type DumpInfo } from "./crashDumpsCore";

/**
 * Native crash dumps are written locally and never uploaded: no submit URL, and
 * `uploadToServer: false`. Call after the profile path is final (headless runs
 * relocate userData first).
 */
export function startLocalCrashDumps(): void {
  try {
    crashReporter.start({ submitURL: "", uploadToServer: false, compress: true, ignoreSystemCrashHandler: false });
  } catch (err) {
    console.warn("crash dumps unavailable:", (err as Error).message);
  }
}

/** Dumps Chromium's handler has finished writing (`completed/`), plus loose ones. */
export async function listDumps(): Promise<(DumpInfo & { file: string })[]> {
  const root = app.getPath("crashDumps");
  const out: (DumpInfo & { file: string })[] = [];
  for (const dir of [path.join(root, "completed"), root]) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter(isDumpName)) {
      const file = path.join(dir, name);
      try {
        const st = await fs.stat(file);
        if (st.isFile()) out.push({ name, file, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished between readdir and stat */ }
    }
  }
  return out;
}

/** The newest few within the size cap; the caller decides whether to bundle them. */
export async function pickDumps() {
  const all = await listDumps();
  const byName = new Map(all.map((d) => [d.name, d.file]));
  const { included, skipped } = selectDumps(all);
  return { included: included.map((d) => ({ ...d, file: byName.get(d.name)! })), skipped };
}
