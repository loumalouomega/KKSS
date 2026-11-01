/**
 * Expansion of a multi-parameter sweep into concrete rows.
 *
 * Pure. The row count is computed *before* anything is allocated, so an
 * oversized grid is refused with its arithmetic instead of being built and
 * truncated. A single parameter expands exactly like the original one-path
 * sweep (same labels), in either mode.
 */
import type { Json } from './contracts';

export const SWEEP_ROW_CAP = 50;
export const SWEEP_PARAMETER_CAP = 4;
export type SweepMode = 'grid' | 'paired';
export interface SweepParameter { name: string; values: Json[] }
export interface SweepRow { label: string; assignment: Record<string, Json> }

const show = (value: Json): string => typeof value === 'string' ? value : JSON.stringify(value);

export function parseSweepMode(value: unknown): SweepMode {
  if (value === undefined || value === 'grid') return 'grid';
  if (value === 'paired') return 'paired';
  throw new Error('mode must be "grid" (all combinations) or "paired" (equal-length lists).');
}

export function expandSweep(parameters: SweepParameter[], mode: SweepMode): { rows: SweepRow[]; count: number; summary: string } {
  if (!Array.isArray(parameters) || parameters.length < 1 || parameters.length > SWEEP_PARAMETER_CAP) throw new Error(`Sweep 1–${SWEEP_PARAMETER_CAP} parameters.`);
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (!parameter || typeof parameter.name !== 'string' || !parameter.name) throw new Error('Every sweep parameter needs a name.');
    if (names.has(parameter.name)) throw new Error(`"${parameter.name}" is swept twice.`);
    names.add(parameter.name);
    if (!Array.isArray(parameter.values) || parameter.values.length < 1) throw new Error(`"${parameter.name}" needs at least one value.`);
    if (new Set(parameter.values.map(value => JSON.stringify(value))).size !== parameter.values.length) throw new Error(`"${parameter.name}" has repeated values.`);
  }
  let count: number, summary: string;
  if (mode === 'paired') {
    const lengths = parameters.map(parameter => parameter.values.length);
    if (new Set(lengths).size !== 1) throw new Error(`Paired lists must have equal length (${parameters.map((p, i) => `${p.name}: ${lengths[i]}`).join(', ')}).`);
    count = lengths[0];
    summary = `paired ${parameters.length} list${parameters.length === 1 ? '' : 's'} → ${count} rows`;
  } else {
    count = parameters.reduce((product, parameter) => product * parameter.values.length, 1);
    summary = `grid ${parameters.map(parameter => parameter.values.length).join(' × ')}${parameters.length > 1 ? ` = ${count}` : ''} rows`;
  }
  if (count > SWEEP_ROW_CAP) throw new Error(`The sweep expands to ${parameters.length > 1 && mode === 'grid' ? `${parameters.map(p => p.values.length).join(' × ')} = ` : ''}${count} rows; the cap is ${SWEEP_ROW_CAP}.`);
  const rows: SweepRow[] = [];
  for (let index = 0; index < count; index++) {
    const assignment: Record<string, Json> = {};
    if (mode === 'paired') parameters.forEach(parameter => { assignment[parameter.name] = parameter.values[index]; });
    else {
      let rest = index;
      // Last parameter varies fastest, so rows read like nested loops.
      for (let k = parameters.length - 1; k >= 0; k--) {
        const size = parameters[k].values.length;
        assignment[parameters[k].name] = parameters[k].values[rest % size];
        rest = Math.floor(rest / size);
      }
    }
    const ordered = Object.fromEntries(parameters.map(parameter => [parameter.name, assignment[parameter.name]]));
    rows.push({ label: parameters.map(parameter => `${parameter.name}=${show(ordered[parameter.name])}`).join(', '), assignment: ordered });
  }
  return { rows, count, summary };
}
