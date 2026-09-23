import type { Evidence, Finding, Quantity, Run, Study } from './contracts';
/** Conservative MDPA summary: count records, never infer mesh quality. */
export function mdpaCounts(text: string): { nodes: number; elements: number; conditions: number } {
  const counts = { nodes: 0, elements: 0, conditions: 0 };
  let active: keyof typeof counts | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const begin = /^Begin\s+(Nodes|Elements|Conditions)(?:\s|$)/i.exec(line);
    if (begin) { active = begin[1].toLowerCase() as keyof typeof counts; continue; }
    if (/^End\s+(Nodes|Elements|Conditions)\s*$/i.test(line)) { active = undefined; continue; }
    if (active && line && !line.startsWith('//') && !line.startsWith('#')) counts[active]++;
  }
  return counts;
}
const CONVERGENCE_ADAPTER = 'kkss.structural-convergence';
interface StructuralMonitor { samples: Evidence['convergence']['samples']; invalid: number }
export function parseStructuralConvergence(text: string): StructuralMonitor {
  const samples: Evidence['convergence']['samples'] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid++; continue; }
      const value = row as Record<string, unknown>;
      if (value.adapter !== CONVERGENCE_ADAPTER || value.version !== 1 || !Number.isSafeInteger(value.iteration) ||
          typeof value.time !== 'number' || !Number.isFinite(value.time) || typeof value.converged !== 'boolean') { invalid++; continue; }
      samples.push({ iteration: value.iteration as number, time: value.time, converged: value.converged });
    } catch { invalid++; }
  }
  return { samples, invalid };
}
export function buildEvidence(run: Run, meshText?: string, convergenceText?: string, savedQuantities: Quantity[] = [], staleQuantityCount = 0): Evidence {
  const findings: Finding[] = [];
  if (!meshText) findings.push({ severity: 'unavailable', message: 'Mesh statistics are unavailable for this format or artifact.' });
  if (!run.artifacts.some(artifact => artifact.role === 'result' && artifact.ownerId === run.id)) findings.push({ severity: 'unavailable', message: 'No result file with a bounded content revision is attached to this run.' });
  if (run.receipt?.message) findings.push({ severity: 'unavailable', message: run.receipt.message });
  const monitor = convergenceText === undefined ? undefined : parseStructuralConvergence(convergenceText);
  let convergence: Evidence['convergence'] = { adapter: 'none', state: 'unavailable', samples: [] };
  if (run.settings && typeof run.settings === 'object' && !Array.isArray(run.settings) && (run.settings as Record<string, unknown>).problemtypeId !== 'structural') {
    findings.push({ severity: 'unavailable', message: `Convergence diagnostics are unsupported for problemtype "${String((run.settings as Record<string, unknown>).problemtypeId ?? 'unknown')}".` });
  } else if (!monitor) {
    findings.push({ severity: 'unavailable', message: 'No versioned structural solver monitor is attached; process completion does not establish convergence.' });
  } else if (monitor.invalid || monitor.samples.length === 0) {
    findings.push({ severity: 'unavailable', message: `Structural convergence monitor is truncated, unsupported or empty (${monitor.invalid} invalid record(s)).` });
    convergence = { adapter: `${CONVERGENCE_ADAPTER}/v1`, state: 'unavailable', samples: monitor.samples };
  } else {
    const anyDiverged = monitor.samples.some(sample => !sample.converged);
    const state = anyDiverged ? 'diverged' : run.state === 'succeeded' ? 'converged' : 'unavailable';
    convergence = { adapter: `${CONVERGENCE_ADAPTER}/v1`, state, samples: monitor.samples };
    if (state === 'unavailable') findings.push({ severity: 'unavailable', message: 'The solve ended before successful completion; recorded converged steps do not establish convergence of the full run.' });
    if (anyDiverged) findings.push({ severity: 'warning', message: 'The structural monitor recorded a solve step that did not converge.' });
  }
  const quantities = savedQuantities.filter(quantity => quantity.runId === run.id && run.artifacts.some(artifact => artifact.role === 'result' && artifact.ownerId === run.id && artifact.reference.kind === quantity.source.kind && artifact.reference.path === quantity.source.path && artifact.reference.revision === quantity.source.revision));
  if (!quantities.length) findings.push({ severity: 'unavailable', message: 'No current scalar quantity evaluation is saved for this run.' });
  if (staleQuantityCount) findings.push({ severity: 'unavailable', message: `${staleQuantityCount} saved quantity evaluation(s) refer to an older result revision and are omitted.` });
  return {
    version: 1, runId: run.id, findings,
    mesh: meshText ? mdpaCounts(meshText) : {},
    convergence, quantities,
  };
}
export interface Review {
  version: 1; projectRevision: number; studyId: string; studyName: string;
  sourceRevision: string; meshRevision: string; settings: Run['settings'];
  run: { id: string; state: Run['state']; startedAt?: number; finishedAt?: number };
  evidence: Evidence; artifacts: Run['artifacts'];
}
export function makeReview(projectRevision: number, study: Study, run: Run, meshText?: string, convergenceText?: string, savedQuantities: Quantity[] = [], staleQuantityCount = 0): Review {
  const evidence = buildEvidence(run, meshText, convergenceText, savedQuantities, staleQuantityCount);
  return {
    version: 1, projectRevision, studyId: study.id, studyName: study.name,
    sourceRevision: run.sourceRevision, meshRevision: run.meshRevision,
    settings: structuredClone(run.settings),
    run: { id: run.id, state: run.state, ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}), ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}) },
    evidence, artifacts: structuredClone(run.artifacts),
  };
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function reviewHtml(review: Review): string {
  const json = JSON.stringify(review, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const samples = review.evidence.convergence.samples;
  const points = samples.map((sample, i) => `${samples.length < 2 ? 480 : 40 + i * 880 / (samples.length - 1)},${sample.converged ? 28 : 112}`).join(' ');
  const plot = samples.length ? `<svg role="img" aria-label="Structural solve-step convergence history" viewBox="0 0 960 140"><line x1="40" y1="28" x2="920" y2="28" stroke="#4a8"/><line x1="40" y1="112" x2="920" y2="112" stroke="#c55"/><polyline fill="none" stroke="#2674c8" stroke-width="3" points="${points}"/></svg><p>Structural solve-step outcomes are shown; residual values are unavailable.</p>` : '<p>Convergence history is unavailable.</p>';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Run review — ${escapeHtml(review.studyName)}</title><style>body{font:15px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#222}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f3f3;padding:1rem;border-radius:8px}svg{width:100%;height:auto;background:#f7f7f7}</style><h1>Run review: ${escapeHtml(review.studyName)}</h1><p>Run state: ${escapeHtml(review.run.state)}. Convergence: ${escapeHtml(review.evidence.convergence.state)}.</p><p>Process completion and numerical convergence are reported separately.</p>${plot}<pre>${escapeHtml(json)}</pre></html>`;
}
