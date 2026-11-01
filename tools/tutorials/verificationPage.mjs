// One table of every tutorial's recorded verification (roadmap item 17). Pure:
// reads the published verification.json records, never runs a solver.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkRows } from './docIslands.mjs';

const BEGIN = '<!-- verification:table:begin -->';
const END = '<!-- verification:table:end -->';
const cell = (t) => String(t).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function loadReports(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'verification.json')))
    .map((e) => JSON.parse(fs.readFileSync(path.join(dir, e.name, 'verification.json'), 'utf8')))
    .sort((a, b) => String(a.case).localeCompare(String(b.case)));
}

export function renderTable(reports) {
  const lines = ['| Case | Check | Measured | Limit | Kratos | Mesh |', '|---|---|---|---|---|---|'];
  for (const r of reports) {
    const mesh = `${r.nodes ?? '?'} nodes${r.elements ? ` / ${r.elements} cells` : ''}`;
    const rows = checkRows(r.checks).filter((row) => row.limit);
    if (!rows.length) lines.push(`| ${cell(r.case)} | — (no asserted limit recorded) | | | ${cell(r.kratos)} | ${cell(mesh)} |`);
    for (const row of rows) lines.push(`| ${cell(r.case)} | \`${cell(row.name)}\` | ${cell(row.measured)} | ${cell(row.limit)} | ${cell(r.kratos)} | ${cell(mesh)} |`);
  }
  return lines.join('\n');
}

export function renderPage(markdown, reports) {
  const a = markdown.indexOf(BEGIN), b = markdown.indexOf(END);
  if (a < 0 || b < a) throw new Error('verification page markers missing');
  return `${markdown.slice(0, a + BEGIN.length)}\n\n${renderTable(reports)}\n\n${markdown.slice(b)}`;
}
