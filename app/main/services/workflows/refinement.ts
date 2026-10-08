import type { Evidence, Run } from './contracts';
import { fingerprint } from './project';
export interface Refinement {
  meshRevision: string; characteristicSize?: number; domainMeasure?: number;
  lengthUnit: 'm' | 'cm' | 'mm'; dimension: 1 | 2 | 3;
  method: 'uniform' | 'adaptive'; sizingDefinition: string; justification: string;
  comparable: boolean; asymptotic: boolean;
}
export interface MeshSensitivity {
  method: 'Richardson/GCI'; safetyFactor: 1.25; orderTolerance: 0.1;
  assumptions: string[]; unavailableReasons: string[];
  inputs: { studyId: string; runId: string; meshRevision: string; h: number | null; value: number | null; refinement?: Refinement }[];
  triples: { runIds: string[]; ratios: number[]; observedOrder: number | null; extrapolatedValue: number | null; gciPercent: number | null }[];
}
export function validateRefinement(value: Refinement): void {
  if (!['m', 'cm', 'mm'].includes(value.lengthUnit) || ![1, 2, 3].includes(value.dimension) || !['uniform', 'adaptive'].includes(value.method)) throw new Error('Declare a supported length unit, dimension and refinement method.');
  for (const n of [value.characteristicSize, value.domainMeasure]) if (n !== undefined && (!Number.isFinite(n) || n <= 0)) throw new Error('Refinement sizes and domain measures must be positive finite numbers.');
  if (!value.characteristicSize && (value.method !== 'uniform' || !value.domainMeasure)) throw new Error('Adaptive refinement requires an explicit characteristic size; uniform refinement may use domain measure and element count.');
  if (!value.sizingDefinition?.trim() || !value.justification?.trim()) throw new Error('Declare a consistent sizing definition and justify its applicability.');
  if (typeof value.comparable !== 'boolean' || typeof value.asymptotic !== 'boolean') throw new Error('Explicit comparability and asymptotic assumptions are required.');
}
export function richardson(h: number[], f: number[]): { ratios: number[]; observedOrder: number; extrapolatedValue: number; gciPercent: number | null } | undefined {
  const [h1, h2, h3] = h, [f1, f2, f3] = f;
  if (![...h, ...f].every(Number.isFinite) || !(h1 > 0 && h2 > h1 && h3 > h2)) return;
  const d21 = f2 - f1, d32 = f3 - f2;
  const floor = Number.EPSILON * Math.max(...f.map(Math.abs), Number.MIN_VALUE) * 32;
  if (Math.abs(d21) <= floor || Math.abs(d32) <= floor || Math.sign(d21) !== Math.sign(d32)) return;
  const r21 = h2 / h1, r32 = h3 / h2;
  if (r21 <= 1.000001 || r32 <= 1.000001) return;
  const target = Math.log(Math.abs(d32 / d21));
  const predicted = (p: number) => p * Math.log(r21) + Math.log(Math.expm1(p * Math.log(r32))) - Math.log(Math.expm1(p * Math.log(r21)));
  let lo = 1e-6, hi = 100;
  if (target <= predicted(lo) || target >= predicted(hi)) return;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (predicted(mid) < target) lo = mid; else hi = mid; }
  const observedOrder = (lo + hi) / 2;
  const correction = d21 / Math.expm1(observedOrder * Math.log(r21));
  const extrapolatedValue = f1 - correction;
  const gciPercent = f1 === 0 ? null : 125 * Math.abs(correction / f1);
  if (![observedOrder, extrapolatedValue, ...(gciPercent === null ? [] : [gciPercent])].every(Number.isFinite)) return;
  return { ratios: [r21, r32], observedOrder, extrapolatedValue, gciPercent };
}
export function meshSensitivity(rows: { studyId: string; run?: Run; evidence?: Evidence; value: number | null }[], compatible: boolean): MeshSensitivity {
  const unavailableReasons: string[] = [];
  const result: MeshSensitivity = { method: 'Richardson/GCI', safetyFactor: 1.25, orderTolerance: 0.1,
    assumptions: ['Comparable geometry, physical settings and discretization family.', 'Monotone convergence in an assumed asymptotic range.', 'Characteristic size represents refinement for this quantity; adaptive sizing is user-supplied.', 'With four or more levels, consecutive orders must agree within 10% (heuristic, not proof).'],
    unavailableReasons, inputs: [], triples: [] };
  const settings = new Set<string>(), sources = new Set<string>(), revisions = new Set<string>(), definitions = new Set<string>();
  for (const row of rows) {
    const run = row.run, metadata = run?.refinement;
    let h: number | null = null;
    if (run) { settings.add(fingerprint({ settings: run.settings, resources: run.resources ?? run.receipt?.resources })); sources.add(run.sourceRevision); revisions.add(run.meshRevision); }
    if (!run || run.state !== 'succeeded' || row.evidence?.convergence.state === 'diverged' || !row.evidence?.mesh.nodes || !row.evidence?.mesh.elements || row.value === null || !Number.isFinite(row.value)) unavailableReasons.push('Every level needs a successful, non-diverged run and a current finite quantity.');
    if (run && metadata) {
      try {
        validateRefinement(metadata);
        if (metadata.meshRevision !== run.meshRevision || !metadata.comparable || !metadata.asymptotic) throw new Error('Refinement assumptions are unconfirmed or metadata is stale.');
        const size = metadata.characteristicSize ?? (row.evidence?.mesh.elements && metadata.domainMeasure ? Math.pow(metadata.domainMeasure / row.evidence.mesh.elements, 1 / metadata.dimension) : NaN);
        h = size * ({ m: 1, cm: 0.01, mm: 0.001 })[metadata.lengthUnit];
        if (!Number.isFinite(h) || h <= 0) throw new Error('A current element count or explicit size is required.');
        if (metadata.method === 'uniform' && !metadata.characteristicSize && !row.evidence?.mesh.elements) throw new Error('Uniform count-derived refinement needs current element counts.');
        definitions.add(fingerprint({ dimension: metadata.dimension, method: metadata.method, definition: metadata.sizingDefinition }));
      } catch (error) { h = null; unavailableReasons.push(String(error)); }
    } else unavailableReasons.push('Revision-bound refinement metadata is missing.');
    result.inputs.push({ studyId: row.studyId, runId: run?.id ?? '', meshRevision: run?.meshRevision ?? '', h, value: row.value, ...(metadata ? { refinement: metadata } : {}) });
  }
  if (rows.length < 3 || revisions.size !== rows.length) unavailableReasons.push('At least three distinct mesh revisions are required.');
  if (!compatible || settings.size !== 1 || sources.size !== 1 || definitions.size !== 1) unavailableReasons.push('Units, physical/solver settings, geometry and sizing definitions must be compatible.');
  result.inputs.sort((a, b) => (a.h ?? Infinity) - (b.h ?? Infinity));
  if (!unavailableReasons.length) {
    for (let i = 0; i + 2 < result.inputs.length; i++) {
      const triple = result.inputs.slice(i, i + 3);
      const numbers = richardson(triple.map(row => row.h!), triple.map(row => row.value!));
      if (!numbers) unavailableReasons.push('A triple is oscillatory, degenerate, insufficiently refined, or has no positive finite observed order (search range 0–100).');
      result.triples.push({ runIds: triple.map(row => row.runId), ratios: [triple[1].h! / triple[0].h!, triple[2].h! / triple[1].h!], observedOrder: null, extrapolatedValue: null, gciPercent: null, ...numbers });
    }
    const orders = result.triples.map(t => t.observedOrder);
    if (orders.some((p, i) => i > 0 && p !== null && orders[i - 1] !== null && Math.abs(p - orders[i - 1]!) / Math.max(p, orders[i - 1]!) > 0.1)) unavailableReasons.push('Consecutive observed orders differ by more than 10%; asymptotic consistency failed.');
  }
  if (unavailableReasons.length) for (const triple of result.triples) { triple.observedOrder = null; triple.extrapolatedValue = null; triple.gciPercent = null; }
  result.unavailableReasons = [...new Set(unavailableReasons)];
  return result;
}
