// Pure selection and description of local crash dumps (crashDumps.ts is the
// Electron/fs glue). Dumps are written by Chromium's crash handler to a folder
// on this machine and never transmitted.

export interface DumpInfo { name: string; mtimeMs: number; size: number }

export const MAX_DUMPS = 5;
export const MAX_DUMP_BYTES = 20 * 1024 * 1024;

/** Only `.dmp` files count; Crashpad keeps metadata and databases beside them. */
export const isDumpName = (name: string): boolean => /\.dmp$/i.test(name) && !/[\\/]/.test(name);

/**
 * Newest first, at most `maxCount` files and `maxBytes` in total. A dump that
 * would push the total over the cap is skipped, not truncated (a cut-off dump is
 * unreadable), and an older, smaller one may still fit.
 */
export function selectDumps(
  list: readonly DumpInfo[],
  limits: { maxCount?: number; maxBytes?: number } = {},
): { included: DumpInfo[]; skipped: DumpInfo[] } {
  const maxCount = limits.maxCount ?? MAX_DUMPS;
  const maxBytes = limits.maxBytes ?? MAX_DUMP_BYTES;
  const included: DumpInfo[] = [];
  const skipped: DumpInfo[] = [];
  let total = 0;
  for (const d of [...list.filter((x) => isDumpName(x.name))].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (included.length < maxCount && total + d.size <= maxBytes) {
      included.push(d);
      total += d.size;
    } else skipped.push(d);
  }
  return { included, skipped };
}

/** What the manifest and the consent dialog say about each dump — no paths. */
export function describeDump(d: DumpInfo): { name: string; date: string; bytes: number } {
  return { name: d.name, date: new Date(d.mtimeMs).toISOString(), bytes: d.size };
}
