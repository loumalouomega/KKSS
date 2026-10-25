import { describe, it, expect } from 'vitest';
import { distributeProjectParameters } from '../app/main/services/workflows/mpiCase';

const params = (over: object = {}) => JSON.stringify({
  analysis_stage: 'x', problem_data: { problem_name: 'p', parallel_type: 'OpenMP' },
  solver_settings: { solver_type: 'Static', linear_solver_settings: { solver_type: 'amgcl' } }, ...over,
});

describe('distributeProjectParameters', () => {
  it('marks the problem as MPI and leaves everything else untouched', () => {
    const r = distributeProjectParameters(params());
    expect(r.ok && r.changed).toBe(true);
    if (r.ok) {
      expect((r.parameters.problem_data as { parallel_type: string }).parallel_type).toBe('MPI');
      expect(r.parameters.solver_settings).toEqual(JSON.parse(params()).solver_settings);
    }
  });
  it('is idempotent', () => {
    const once = distributeProjectParameters(params());
    if (!once.ok) throw new Error('expected ok');
    const twice = distributeProjectParameters(JSON.stringify(once.parameters));
    expect(twice.ok && twice.changed).toBe(false);
  });
  it('refuses serial-only linear solvers at any depth instead of swapping them', () => {
    const r = distributeProjectParameters(params({ solver_settings: { solver_type: 'Static', linear_solver_settings: { solver_type: 'skyline_lu_factorization' } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/skyline_lu_factorization.*several ranks/);
  });
  it('refuses unreadable or incomplete parameters', () => {
    for (const raw of ['{', '[]', JSON.stringify({ solver_settings: {} }), JSON.stringify({ problem_data: {} })]) expect(distributeProjectParameters(raw).ok).toBe(false);
  });
});
