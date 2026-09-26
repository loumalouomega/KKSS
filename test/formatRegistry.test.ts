import { expect, it } from 'vitest';
import { parseFormatCounts, checkFormatDocumentation, readRoutingRegistry } from '../tools/format-registry.mjs';
const source = `export const MESHIO_READ_CANDIDATES: Record<string, string[]> = {
  ".a": ["first", "second"], ".alias": ["first"],
};
export const MESHIO_WRITE_FORMAT: Record<string, string> = {
  ".a": "first", ".alias": "first", ".svg": "svg",
};`;
it('counts reachable format identities, not aliases, including multiple candidates and figures', () => {
  expect(parseFormatCounts(source)).toEqual({ read: 2, write: 2, readExtensions: ['.a', '.alias'], writeExtensions: ['.a', '.alias', '.svg'] });
});
it('fails closed for missing or malformed registries', () => {
  for (const bad of ['', source.replace('["first", "second"]', 'unknown'), source.replace('["first"]', '[]')]) expect(() => parseFormatCounts(bad)).toThrow();
});
it('rejects stale, ambiguous and missing doc claims', () => {
  const counts = parseFormatCounts(source);
  expect(() => checkFormatDocumentation('2 extended readable formats and 2 extended writable formats', counts, 'doc')).not.toThrow();
  for (const bad of ['3 extended readable formats', '2 extended mesh formats', 'no counts']) expect(() => checkFormatDocumentation(bad, counts, 'doc')).toThrow();
});
it('can parse the pinned source registries', () => {
  const { counts, suffixes } = readRoutingRegistry();
  expect(counts.read).toBeGreaterThan(0); expect(counts.write).toBeGreaterThan(0);
  expect(suffixes.has('mdpa')).toBe(true); expect(suffixes.has('post.msh')).toBe(true);
});
