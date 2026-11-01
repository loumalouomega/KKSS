/**
 * Pure planning pieces of a geometry-parameter sweep.
 *
 * A CAD document variable lives in the model's `.edits.json` sidecar, never in
 * the geometry file, so a sweep row is a *copy* of the source file (same bytes,
 * so the same content revision) whose copied sidecar carries different variable
 * values. The user's own model and sidecars are never touched. Everything here
 * is Electron- and filesystem-free; `service.ts` supplies the effects.
 */
import * as path from 'node:path';
import { CAD_SIDECAR_SUFFIXES } from '../sidecarSuffixes';

export const GEOMETRY_ROW_CAP = 50;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** One swept variable's value as the expression text `set_variables` takes. */
export function variableExpressions(name: unknown, values: unknown): { name: string; expressions: string[] } {
  if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) throw new Error('variable must be a CAD document variable name (letters, digits, underscore).');
  if (!Array.isArray(values) || values.length < 1 || values.length > GEOMETRY_ROW_CAP) throw new Error(`Provide 1–${GEOMETRY_ROW_CAP} values.`);
  const expressions = values.map(value => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Values must be finite numbers or expressions.');
      return String(value);
    }
    if (typeof value === 'string' && value.trim() && value.length <= 200) return value.trim();
    throw new Error('Each value must be a finite number or a short expression string.');
  });
  if (new Set(expressions).size !== expressions.length) throw new Error('Sweep values must be distinct.');
  return { name, expressions };
}

/** Where a row's copied model goes: inside its run directory, original file name kept. */
export function geometryDestination(runRoot: string, sourcePath: string): string {
  const base = path.basename(sourcePath);
  if (!base || base === '.' || base === '..') throw new Error('The geometry source has no file name.');
  return `${runRoot}/geometry/${base}`;
}

/** The sidecar files that may sit beside a model (the list the cloud layer shares). */
export function sidecarCandidates(modelPath: string): string[] {
  return CAD_SIDECAR_SUFFIXES.map(suffix => `${modelPath}${suffix}`);
}

export interface DocumentVariable { name: string; expr: string }

/**
 * Replace the swept variable's expression inside the model's full ordered
 * variable list. A name the model does not define is an error: adding one would
 * silently change nothing, because no op references it.
 */
export function overrideVariable(existing: DocumentVariable[], name: string, expr: string): DocumentVariable[] {
  if (!existing.some(variable => variable.name === name)) {
    throw new Error(`The model defines no variable "${name}"${existing.length ? ` (it has: ${existing.map(v => v.name).join(', ')})` : ''}.`);
  }
  return existing.map(variable => variable.name === name ? { name: variable.name, expr } : { name: variable.name, expr: variable.expr });
}
