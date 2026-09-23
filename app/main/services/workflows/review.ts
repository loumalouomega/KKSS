import type { Evidence, Finding, Run, Study } from './contracts';
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
export function buildEvidence(run: Run, meshText?: string): Evidence {
  const findings: Finding[] = [];
  if (!meshText) findings.push({ severity: 'unavailable', message: 'Mesh statistics are unavailable for this format or artifact.' });
  findings.push({ severity: 'unavailable', message: 'No versioned structural solver monitor is attached; process completion does not establish convergence.' });
  findings.push({ severity: 'unavailable', message: 'No scalar quantity evaluation was saved for this run.' });
  return {
    version: 1, runId: run.id, findings,
    mesh: meshText ? mdpaCounts(meshText) : {},
    convergence: { adapter: 'none', state: 'unavailable', samples: [] }, quantities: [],
  };
}
export interface Review {
  version: 1; projectRevision: number; studyId: string; studyName: string;
  sourceRevision: string; meshRevision: string; settings: Run['settings'];
  run: { id: string; state: Run['state']; startedAt?: number; finishedAt?: number };
  evidence: Evidence; artifacts: Run['artifacts'];
}
export function makeReview(projectRevision: number, study: Study, run: Run, meshText?: string): Review {
  const evidence = buildEvidence(run, meshText);
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
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Run review — ${escapeHtml(review.studyName)}</title><style>body{font:15px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#222}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f3f3;padding:1rem;border-radius:8px}</style><h1>Run review: ${escapeHtml(review.studyName)}</h1><p>Run state: ${escapeHtml(review.run.state)}. Convergence: ${escapeHtml(review.evidence.convergence.state)}.</p><p>Process completion and numerical convergence are reported separately.</p><pre>${escapeHtml(json)}</pre></html>`;
}
