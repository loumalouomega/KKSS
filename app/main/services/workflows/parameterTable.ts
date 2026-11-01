/**
 * The swept-parameter table of a variant comparison: one row per study, one
 * column per parameter that differs from the baseline, plus one quantity.
 *
 * Pure. Missing stays `null` — a parameter a study does not carry and a
 * quantity it never saved are never turned into zero. Incompatible units are
 * not tabulated (the same rule `compareVariants` applies to the values).
 */
import type { Json, Study } from './contracts';
import type { QuantityComparison, VariantComparison } from './comparison';

export interface ParameterTableRow { studyId: string; name: string; parameters: Record<string, Json | null>; value: number | null; unit?: string }
export interface ParameterTable {
  quantity: QuantityComparison['definition']; unit?: string; parameters: string[]; rows: ParameterTableRow[];
  /** First parameter whose every present value is a finite number: the only one a line plot can use. */
  numericAxis?: string; findings: string[];
}

export function parameterTables(comparison: VariantComparison, studies: Pick<Study, 'id' | 'geometry'>[]): ParameterTable[] {
  const geometry = new Map(studies.map(study => [study.id, study.geometry?.variables]));
  const parameterValues = new Map<string, Map<string, Json | null>>();
  const columns: string[] = [];
  const note = (studyId: string, name: string, value: Json | null) => {
    if (!columns.includes(name)) columns.push(name);
    const row = parameterValues.get(studyId) ?? new Map<string, Json | null>();
    row.set(name, value); parameterValues.set(studyId, row);
  };
  for (const diff of comparison.differences) {
    for (const change of diff.changes) note(diff.studyId, change.path, change.valuePresent ? change.value : null);
  }
  for (const row of comparison.rows) {
    for (const [name, expression] of Object.entries(geometry.get(row.studyId) ?? {})) {
      const number = Number(expression);
      note(row.studyId, `geometry.${name}`, expression.trim() !== '' && Number.isFinite(number) ? number : expression);
    }
  }
  return comparison.quantities.filter(quantity => quantity.compatible).map(quantity => {
    const rows: ParameterTableRow[] = comparison.rows.map(row => {
      const found = quantity.values.find(value => value.studyId === row.studyId);
      const values = parameterValues.get(row.studyId);
      return { studyId: row.studyId, name: row.name,
        parameters: Object.fromEntries(columns.map(column => [column, values?.has(column) ? values.get(column)! : null])),
        value: found?.value !== undefined && Number.isFinite(found.value) ? found.value : null, ...(found?.unit ? { unit: found.unit } : {}) };
    });
    const numericAxis = columns.find(column => {
      const present = rows.map(row => row.parameters[column]).filter(value => value !== null);
      return present.length >= 2 && present.every(value => typeof value === 'number' && Number.isFinite(value));
    });
    const findings: string[] = [];
    if (!columns.length) findings.push('No swept parameters differ from the baseline.');
    const missing = rows.filter(row => row.value === null).length;
    if (missing) findings.push(`${missing} row${missing === 1 ? '' : 's'} have no saved value for this quantity; they stay missing.`);
    return { quantity: quantity.definition, ...(quantity.unit ? { unit: quantity.unit } : {}), parameters: columns, rows,
      ...(numericAxis ? { numericAxis } : {}), findings };
  });
}

const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const tick = (value: number): string => Number.isInteger(value) ? String(value) : Number(value.toPrecision(4)).toString();

/**
 * Self-contained SVG of the quantity against the numeric axis (points joined in
 * axis order). Rows with a missing value are left off the drawing and counted in
 * the caption; nothing here executes or fetches anything.
 */
export function parameterPlotSvg(table: ParameterTable): string {
  const axis = table.numericAxis;
  if (!axis) return '';
  const points = table.rows.flatMap(row => {
    const x = row.parameters[axis];
    return typeof x === 'number' && row.value !== null ? [{ x, y: row.value }] : [];
  }).sort((a, b) => a.x - b.x);
  const omitted = table.rows.length - points.length;
  if (points.length < 1) return '';
  const w = 520, h = 260, left = 64, right = 16, top = 16, bottom = 44;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => left + (x1 === x0 ? (w - left - right) / 2 : (x - x0) / (x1 - x0) * (w - left - right));
  const sy = (y: number) => h - bottom - (y1 === y0 ? (h - top - bottom) / 2 : (y - y0) / (y1 - y0) * (h - top - bottom));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const label = `${table.quantity.kind} ${table.quantity.field}/${table.quantity.component}${table.unit ? ` (${table.unit})` : ''} versus ${axis}`;
  return `<figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">`
    + `<rect width="${w}" height="${h}" fill="#fff" stroke="#ccc"/><path d="${path}" fill="none" stroke="#1f6feb" stroke-width="2"/>`
    + points.map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="#1f6feb"><title>${esc(`${axis}=${p.x}, ${p.y}`)}</title></circle>`).join('')
    + `<text x="${left}" y="${h - 8}" font-size="12">${esc(`${axis}: ${tick(x0)} … ${tick(x1)}`)}</text>`
    + `<text x="6" y="${top + 10}" font-size="12">${esc(`${tick(y1)}`)}</text><text x="6" y="${h - bottom}" font-size="12">${esc(`${tick(y0)}`)}</text></svg>`
    + `<figcaption>${esc(label)}${omitted ? ` — ${omitted} row${omitted === 1 ? ' is' : 's are'} not drawn (no value for this quantity, or no value for ${esc(axis)})` : ''}</figcaption></figure>`;
}
