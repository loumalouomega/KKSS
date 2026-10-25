/**
 * Pure rewrite of a generated `ProjectParameters.json` for an MPI launch. Kratos selects its
 * distributed solver wrappers from `problem_data.parallel_type` and partitions the model part in
 * memory at import, so no pre-partitioned `.mdpa` is produced. A case this module cannot prove is
 * safe to distribute is refused with a reason; it never falls back to a serial run.
 */
import type { Json } from './contracts';

/** Direct/serial-only linear solvers: a rank set cannot share them, and swapping silently would change the numerics. */
const SERIAL_LINEAR_SOLVERS = new Set([
  'skyline_lu_factorization', 'eigen_sparse_lu', 'eigen_sparse_cg', 'sparse_lu', 'LinearSolversApplication.sparse_lu',
  'pardiso_lu', 'LinearSolversApplication.pardiso_lu', 'super_lu', 'ublas_cg',
]);
export type MpiCaseResult = { ok: true; parameters: { [key: string]: Json }; changed: boolean } | { ok: false; reason: string };

const isObject = (v: unknown): v is { [key: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);

export function distributeProjectParameters(raw: string): MpiCaseResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: 'ProjectParameters.json is not valid JSON.' }; }
  if (!isObject(parsed)) return { ok: false, reason: 'ProjectParameters.json is not an object.' };
  const problem = parsed.problem_data;
  if (!isObject(problem)) return { ok: false, reason: 'ProjectParameters.json has no problem_data block to mark as distributed.' };
  const solver = parsed.solver_settings;
  if (!isObject(solver)) return { ok: false, reason: 'ProjectParameters.json has no solver_settings block.' };
  const blocking = serialSolvers(solver);
  if (blocking.length) return { ok: false, reason: `Linear solver "${blocking[0]}" cannot run on several ranks; choose a distributed-capable solver (for example amgcl) and approve a new plan.` };
  const out = JSON.parse(raw) as { [key: string]: Json };
  const changed = (out.problem_data as { [key: string]: Json }).parallel_type !== 'MPI';
  (out.problem_data as { [key: string]: Json }).parallel_type = 'MPI';
  return { ok: true, parameters: out, changed };
}

function serialSolvers(node: Json, found: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach(n => serialSolvers(n, found));
  else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'solver_type' && typeof value === 'string' && SERIAL_LINEAR_SOLVERS.has(value)) found.push(value);
      else serialSolvers(value, found);
    }
  }
  return found;
}
