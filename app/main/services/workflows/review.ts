import { table, jsonTwin } from './reportHtml';
import { CONVERGENCE_ADAPTERS } from '../../../../mesh/src/problemtype/mainKratosTemplate';
import type { Evidence, Finding, Json, Quantity, Run, Study } from './contracts';
import { convergencePlots } from '../../../shared/convergencePlots';
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
interface StructuralMonitor { samples: Evidence['convergence']['samples']; invalid: number; version?: number; completed: boolean }
export function parseStructuralConvergence(text: string, adapter = CONVERGENCE_ADAPTER): StructuralMonitor {
  const samples: Evidence['convergence']['samples'] = [];
  let invalid = 0;
  let version: number | undefined, completed = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid++; continue; }
      const value = row as Record<string, unknown>;
      if (completed || value.adapter !== adapter || ![1, 2].includes(value.version as number) ||
          (version !== undefined && version !== value.version)) { invalid++; continue; }
      version = value.version as number;
      if (version === 2 && value.event === 'end') {
        if (value.completed !== true) invalid++;
        else completed = true;
        continue;
      }
      if ((version === 2 && value.event !== 'step') || !Number.isSafeInteger(value.iteration) ||
          typeof value.time !== 'number' || !Number.isFinite(value.time) ||
          !(typeof value.converged === 'boolean' || (version === 2 && value.converged === null))) { invalid++; continue; }
      const sample: Evidence['convergence']['samples'][number] = { iteration: value.iteration as number, time: value.time, converged: value.converged as boolean | null };
      if (version === 2) {
        if (typeof value.solverStepResult === 'boolean' || value.solverStepResult === null) sample.solverStepResult = value.solverStepResult;
        if (typeof value.analysisType === 'string') sample.analysisType = value.analysisType;
        if (value.criterionParameters && typeof value.criterionParameters === 'object' && !Array.isArray(value.criterionParameters)) sample.criterionParameters = value.criterionParameters as Json;
        for (const key of ['residual', 'convergenceRatio', 'nonlinearIteration'] as const) {
          if (value[key] === undefined) continue;
          if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 ||
              (key === 'nonlinearIteration' && !Number.isSafeInteger(value[key]))) { invalid++; continue; }
          sample[key] = value[key];
        }
        for (const key of ['criterion', 'residualDefinition', 'residualUnavailableReason'] as const) {
          if (typeof value[key] === 'string') sample[key] = value[key];
        }
        if (value.runtime && typeof value.runtime === 'object' && !Array.isArray(value.runtime)) sample.runtime = value.runtime as Json;
      }
      samples.push(sample);
    } catch { invalid++; }
  }
  return { samples, invalid, version, completed: version === 1 || completed };
}
export interface ReviewEvidenceExtras {
  meshCounts?: { nodes: number; elements: number; conditions: number };
  meshStatisticsUnavailableReason?: string;
  meshQuality?: Json;
  meshQualityUnavailableReason?: string;
  preparation?: Evidence['preparation'];
}
export function buildEvidence(run: Run, meshText?: string, convergenceText?: string, savedQuantities: Quantity[] = [], staleQuantityCount = 0, extras: ReviewEvidenceExtras = {}): Evidence {
  const findings: Finding[] = [];
  if (!meshText && !extras.meshCounts) findings.push({ severity: 'unavailable', message: extras.meshStatisticsUnavailableReason ?? 'Mesh statistics are unavailable for this format or artifact.' });
  if (extras.meshQuality === undefined) findings.push({ severity: 'unavailable', message: `Mesh-quality metrics are unavailable: ${extras.meshQualityUnavailableReason ?? 'no verified report was collected.'}` });
  if (extras.meshQuality && typeof extras.meshQuality === 'object' && !Array.isArray(extras.meshQuality) && extras.meshQuality.overallOk === false) {
    findings.push({ severity: 'warning', message: 'The mesh-quality report contains failing metrics; inspect the embedded metric bands and bad-entity counts.' });
  }
  if (!extras.preparation || extras.preparation.state !== 'complete') {
    const state = extras.preparation?.state ?? 'unavailable';
    findings.push({ severity: 'unavailable', message: `Preparation provenance is ${state}; inspect the revision-checked input list for missing or changed files.` });
  }
  if (extras.preparation?.reportUnavailableReason) findings.push({ severity: 'unavailable', message: extras.preparation.reportUnavailableReason });
  if (!run.artifacts.some(artifact => artifact.role === 'result' && artifact.ownerId === run.id)) findings.push({ severity: 'unavailable', message: 'No result file with a bounded content revision is attached to this run.' });
  for (const message of run.outputFindings ?? run.receipt?.outputFindings ?? []) findings.push({ severity: 'unavailable', message });
  if (run.receipt?.message) findings.push({ severity: 'unavailable', message: run.receipt.message });
  const problemtype = run.settings && typeof run.settings === 'object' && !Array.isArray(run.settings) ? String(run.settings.problemtypeId ?? 'structural') : 'structural';
  const adapter = CONVERGENCE_ADAPTERS[problemtype];
  const monitor = convergenceText === undefined || !adapter ? undefined : parseStructuralConvergence(convergenceText, adapter);
  let convergence: Evidence['convergence'] = { adapter: 'none', state: 'unavailable', samples: [] };
  if (!adapter) {
    findings.push({ severity: 'unavailable', message: `Convergence diagnostics are unsupported for problemtype "${problemtype}".` });
  } else if (!monitor) {
    findings.push({ severity: 'unavailable', message: 'No versioned solver monitor is attached; process completion does not establish convergence.' });
  } else if (monitor.invalid || monitor.samples.length === 0) {
    findings.push({ severity: 'unavailable', message: `Solver convergence monitor is truncated, unsupported or empty (${monitor.invalid} invalid record(s)).` });
    convergence = { adapter: `${adapter}/v${monitor.version ?? 'unknown'}`, state: 'unavailable', samples: monitor.samples };
  } else {
    const anyDiverged = monitor.samples.some(sample => sample.converged === false);
    const state = anyDiverged ? 'diverged' : run.state === 'succeeded' && monitor.completed && monitor.samples.every(sample => sample.converged === true) ? 'converged' : 'unavailable';
    convergence = { adapter: `${adapter}/v${monitor.version}`, state, samples: monitor.samples };
    if (state === 'unavailable') findings.push({ severity: 'unavailable', message: 'The monitor does not establish numerical convergence of every step; linear solves, unpublished criteria and incomplete runs remain unavailable.' });
    if (anyDiverged) findings.push({ severity: 'warning', message: 'The solver monitor recorded a solve step that did not converge.' });
  }
  if (monitor?.samples.some(sample => sample.residual === undefined)) findings.push({ severity: 'unavailable', message: 'Residual magnitudes are unavailable for some recorded steps; solve-step outcomes are separate evidence.' });
  const quantities = savedQuantities.filter(quantity => quantity.runId === run.id && run.artifacts.some(artifact => artifact.role === 'result' && artifact.ownerId === run.id && artifact.reference.kind === quantity.source.kind && artifact.reference.path === quantity.source.path && artifact.reference.revision === quantity.source.revision));
  if (!quantities.length) findings.push({ severity: 'unavailable', message: 'No current scalar quantity evaluation is saved for this run.' });
  if (staleQuantityCount) findings.push({ severity: 'unavailable', message: `${staleQuantityCount} saved quantity evaluation(s) refer to an older result revision and are omitted.` });
  return {
    version: 1, runId: run.id, findings,
    mesh: { ...(meshText ? mdpaCounts(meshText) : extras.meshCounts ?? {}), ...(extras.meshQuality !== undefined ? { quality: extras.meshQuality } : {}) },
    ...(extras.preparation ? { preparation: extras.preparation } : {}),
    convergence, quantities,
  };
}
export interface Review {
  resources?: Run['resources'];
  refinement?: Run['refinement'];
  version: 1; projectRevision: number; studyId: string; studyName: string;
  sourceRevision: string; meshRevision: string; settings: Run['settings'];
  run: { id: string; state: Run['state']; startedAt?: number; finishedAt?: number };
  evidence: Evidence; artifacts: Run['artifacts'];
}
export function makeReview(projectRevision: number, study: Study, run: Run, meshText?: string, convergenceText?: string, savedQuantities: Quantity[] = [], staleQuantityCount = 0, extras: ReviewEvidenceExtras = {}): Review {
  const evidence = buildEvidence(run, meshText, convergenceText, savedQuantities, staleQuantityCount, extras);
  return {
    version: 1, projectRevision, studyId: study.id, studyName: study.name,
    sourceRevision: run.sourceRevision, meshRevision: run.meshRevision,
    settings: structuredClone(run.settings),
    run: { id: run.id, state: run.state, ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}), ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}) },
    evidence, artifacts: structuredClone(run.artifacts),
    ...((run.resources ?? run.receipt?.resources) ? { resources: run.resources ?? run.receipt?.resources } : {}), ...(run.refinement ? { refinement: run.refinement } : {}),
  };
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function reviewHtml(review: Review): string {
  const samples = review.evidence.convergence.samples;
  const plot = convergencePlots(samples);
  const sections = table('Findings', ['Severity', 'Finding'], review.evidence.findings.map(f => [f.severity, f.message]))
    + table('Provenance', ['Property', 'Recorded value'], [['Run', review.run.id], ['Source revision', review.sourceRevision], ['Mesh revision', review.meshRevision], ['Settings', review.settings], ['Threads requested', review.resources?.requestedThreads], ['Threads effective', review.resources?.effectiveThreads], ['Refinement', review.refinement]])
    + table('Mesh statistics and quality', ['Property', 'Value'], [['Nodes', review.evidence.mesh.nodes], ['Elements', review.evidence.mesh.elements], ['Conditions', review.evidence.mesh.conditions], ['Quality', review.evidence.mesh.quality]])
    + table('Preparation', ['Role', 'Path', 'Revision', 'State'], review.evidence.preparation?.files.map(f => [f.role, f.reference.path, f.reference.revision, f.state]) ?? [])
    + table('Quantities', ['Field/component', 'Region', 'Time', 'Reduction', 'Unit', 'Value', 'Source revision'], review.evidence.quantities.map(q => [`${q.field}/${q.component}`, q.region, q.time, q.reduction, q.unit, q.value, q.source.revision]));
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Run review — ${escapeHtml(review.studyName)}</title><style>body{font:15px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#222}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f3f3;padding:1rem;border-radius:8px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:.45rem;text-align:left;overflow-wrap:anywhere}svg{width:100%;height:auto;background:#f7f7f7}</style><h1>Run review: ${escapeHtml(review.studyName)}</h1><p>Run state: ${escapeHtml(review.run.state)}. Convergence: ${escapeHtml(review.evidence.convergence.state)}.</p><p>Process completion and numerical convergence are reported separately.</p>${sections}${plot}${jsonTwin(review)}</html>`;
}
