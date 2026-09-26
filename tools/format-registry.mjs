import { readFileSync } from 'node:fs';

function body(source, name, open, close) {
  const clean = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const match = clean.match(new RegExp(`(?:const|let)\\s+${name}\\b[^=]*=\\s*\\${open}([\\s\\S]*?)\\${close}\\s*(?:as const)?\\s*;`));
  if (!match || !match[1].trim()) throw new Error(`Cannot parse nonempty registry ${name}`);
  return match[1];
}
function strings(value) { return [...value.matchAll(/"([^"\n]+)"/g)].map(match => match[1]); }
export function parseFormatCounts(source) {
  const read = body(source, 'MESHIO_READ_CANDIDATES', '{', '}');
  const write = body(source, 'MESHIO_WRITE_FORMAT', '{', '}');
  const readers = [...read.matchAll(/"(\.[^"\n]+)"\s*:\s*\[([^\]]+)\]\s*,?/g)];
  const writers = [...write.matchAll(/"(\.[^"\n]+)"\s*:\s*"([^"\n]+)"\s*,?/g)];
  if (!readers.length || !writers.length || read.replace(/"(\.[^"\n]+)"\s*:\s*\[([^\]]+)\]\s*,?/g, '').trim() || write.replace(/"(\.[^"\n]+)"\s*:\s*"([^"\n]+)"\s*,?/g, '').trim()) throw new Error('Malformed meshio routing registry');
  const readFormats = new Set(readers.flatMap(row => strings(row[2])));
  const writeFormats = new Set(writers.map(row => row[2]));
  if (!readFormats.size || readers.some(row => !strings(row[2]).length)) throw new Error('Empty reader candidates');
  return { read: readFormats.size, write: writeFormats.size, readExtensions: readers.map(row => row[1]), writeExtensions: writers.map(row => row[1]) };
}
export function readRoutingRegistry(root = '.') {
  const read = file => readFileSync(`${root}/${file}`, 'utf8');
  const counts = parseFormatCounts(read('mesh/src/parser/meshioFormats.ts'));
  const cad = body(read('cad/src/fileRouter.ts'), 'EXTENSION_MAP', '{', '}');
  const native = read('mesh/src/parser/meshFormats.ts');
  const suffixes = new Set([
    ...[...cad.matchAll(/^\s*"?([a-z0-9]+(?:\.[a-z0-9]+)*)"?\s*:/gm)].map(match => match[1]),
    ...counts.readExtensions.map(ext => ext.slice(1)),
    ...strings(body(native, 'NATIVE_MESH_EXTENSIONS', '[', ']')).map(ext => ext.replace(/^\./, '')),
    ...strings(body(native, 'VTK_XML_EXTENSIONS', '[', ']')).map(ext => ext.replace(/^\./, '')),
    'mdpa',
  ]);
  return { counts, suffixes };
}
/** Explicit markers work in Markdown prose and YAML frontmatter alike. */
export function checkFormatDocumentation(source, counts, file) {
  const matches = [...source.matchAll(/(\d+) extended (readable|writable) formats/g)];
  if (!matches.length) throw new Error(`${file}: missing explicit readable/writable format count`);
  for (const [, count, direction] of matches) {
    const expected = counts[direction === 'readable' ? 'read' : 'write'];
    if (Number(count) !== expected) throw new Error(`${file}: ${direction} count ${count}, expected ${expected}`);
  }
  if (/~?\d+ extended (?:mesh )?formats/.test(source)) throw new Error(`${file}: ambiguous format count; label readable or writable`);
}
