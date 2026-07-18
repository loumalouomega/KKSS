/**
 * Pure CHANGELOG.md parsing — kept free of electron imports so
 * test/whatsNew.test.ts can exercise it directly (same split as
 * updateCheck.ts/updates.ts).
 */
import type { ChangelogEntry } from "../ipc";

const HEADING_RE = /^## \[(\d+\.\d+\.\d+)] - (\d{4}-\d{2}-\d{2})\s*$/;
const BULLET_RE = /^-\s+(.*)$/;
// Wrapped continuation of the previous bullet (hanging-indent Markdown list style).
const CONTINUATION_RE = /^\s+(\S.*)$/;

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      current = { version: heading[1], date: heading[2], bullets: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      current.bullets.push(bullet[1]);
      continue;
    }
    const continuation = current.bullets.length ? CONTINUATION_RE.exec(line) : null;
    if (continuation) {
      current.bullets[current.bullets.length - 1] += ` ${continuation[1]}`;
    }
  }
  return entries;
}
