import type { Evidence, Json, Run, Study } from './contracts';
import { fingerprint } from './project';

export interface VariantRow {
  studyId: string; name: string; settings: Json; state: string; runId?: string;
  variation: 'mesh-sensitivity' | 'solver-parameter' | 'mixed' | 'unchanged' | 'incomplete';
  convergence: Evidence['convergence']['state'] | 'unavailable'; elapsedMs?: number;
}
export interface QuantityComparison {
  definition: { field: string; kind: string; component: string; region: string; time: number; reduction: string };
  compatible: boolean; unit?: string; values: { studyId: string; runId?: string; value: number | null; unit?: string }[];
}
export interface SettingChange { path: string; baseline: Json | null; value: Json | null; baselinePresent: boolean; valuePresent: boolean }
export interface VariantComparison {
  version: 2; parentStudyId: string; parentName: string;
  classification: 'mesh-sensitivity' | 'solver-parameter' | 'mixed' | 'unchanged' | 'incomplete'; rows: VariantRow[];
  differences: { studyId: string; changes: SettingChange[] }[];
  quantities: QuantityComparison[]; findings: string[];
}
function paths(before: unknown, after: unknown, prefix = ''): string[] {
  if (fingerprint(before) === fingerprint(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(key => paths(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return [prefix || '(root)'];
}
function valueAt(value: Json, dottedPath: string): { present: boolean; value?: Json } {
  let current: unknown = value;
  for (const part of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { present: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { present: true, value: current as Json };
}
export function compareVariants(parent: Study, candidates: { study: Study; run?: Run; evidence?: Evidence }[]): VariantComparison {
  const quantityMap = new Map<string, { definition: QuantityComparison['definition']; entries: Map<string, { runId?: string; value: number | null; unit: string }> }>();
  const baseline = candidates.find(candidate => candidate.study.id === parent.id);
  const rows = candidates.map(({ study, run, evidence }) => {
    for (const quantity of evidence?.quantities ?? []) {
      const definition = { field: quantity.field, kind: quantity.kind, component: quantity.component, region: quantity.region, time: quantity.time, reduction: quantity.reduction };
      const key = fingerprint(definition);
      let item = quantityMap.get(key);
      if (!item) { item = { definition, entries: new Map() }; quantityMap.set(key, item); }
      item.entries.set(study.id, { runId: run?.id, value: Number.isFinite(quantity.value) ? quantity.value : null, unit: quantity.unit });
    }
    const baselineSettings = baseline?.study.caseSettings ?? parent.caseSettings;
    const solverChanged = fingerprint(study.caseSettings) !== fingerprint(baselineSettings);
    const meshingChanged = fingerprint(study.meshing) !== fingerprint(baseline?.study.meshing ?? parent.meshing);
    const baselineMeshRevision = baseline?.run?.meshRevision;
    const meshRevisionKnown = !!baselineMeshRevision && baselineMeshRevision !== 'missing' && !!run?.meshRevision && run.meshRevision !== 'missing';
    const meshChanged = meshingChanged || meshRevisionKnown && run!.meshRevision !== baselineMeshRevision;
    const variation: VariantRow['variation'] = study.id === parent.id ? 'unchanged' : meshChanged && solverChanged ? 'mixed'
      : meshChanged ? 'mesh-sensitivity'
      : solverChanged && meshRevisionKnown ? 'solver-parameter'
      : solverChanged ? 'incomplete'
      : meshRevisionKnown ? 'unchanged' : 'incomplete';
    return {
      studyId: study.id, name: study.name, settings: structuredClone(study.caseSettings),
      variation,
      state: run?.state ?? 'missing', ...(run ? { runId: run.id } : {}),
      convergence: evidence?.convergence.state ?? 'unavailable',
      ...(run?.startedAt !== undefined && run.finishedAt !== undefined ? { elapsedMs: Math.max(0, run.finishedAt - run.startedAt) } : {}),
    } satisfies VariantRow;
  });
  const quantities: QuantityComparison[] = [...quantityMap.values()].map(item => {
    const units = new Set([...item.entries.values()].map(value => value.unit));
    const unit = units.size === 1 ? [...units][0] : undefined;
    return { definition: item.definition, compatible: !!unit, ...(unit ? { unit } : {}), values: candidates.map(({ study, run }) => {
      const value = item.entries.get(study.id);
      return { studyId: study.id, ...(value?.runId ?? run?.id ? { runId: value?.runId ?? run?.id } : {}), value: value?.value ?? null, ...(value ? { unit: value.unit } : {}) };
    }) };
  });
  const findings = quantities.length ? [] : ['No selected scalar quantities are saved for these runs.'];
  if (quantities.some(quantity => !quantity.compatible)) findings.push('Some scalar definitions use incompatible units and are not compared.');
  if (rows.some(row => row.state === 'missing')) findings.push('One or more variants have no recorded run; their values remain missing.');
  const variations = new Set(rows.filter(row => row.studyId !== parent.id).map(row => row.variation));
  const classification: VariantComparison['classification'] = variations.has('mixed') || variations.has('mesh-sensitivity') && variations.has('solver-parameter')
    ? 'mixed' : variations.has('mesh-sensitivity') ? 'mesh-sensitivity' : variations.has('solver-parameter') ? 'solver-parameter'
    : variations.has('incomplete') ? 'incomplete' : 'unchanged';
  if (classification === 'incomplete') findings.push('Study type is incomplete: mesh revisions are needed to distinguish mesh sensitivity from solver-parameter changes.');
  return {
    version: 2, parentStudyId: parent.id, parentName: parent.name, classification, rows,
    differences: candidates.filter(({ study }) => study.id !== parent.id).map(({ study }) => ({ studyId: study.id, changes: paths(parent.caseSettings, study.caseSettings).map(path => {
      const baseline = valueAt(parent.caseSettings, path), value = valueAt(study.caseSettings, path);
      return { path, baseline: baseline.value ?? null, value: value.value ?? null, baselinePresent: baseline.present, valuePresent: value.present };
    }) })),
    quantities, findings,
  };
}
function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function comparisonHtml(comparison: VariantComparison): string {
  const rowHtml = comparison.rows.map(row => `<tr><td>${escape(row.name)}</td><td>${escape(row.state)}</td><td>${escape(row.variation)}</td><td>${escape(row.convergence)}</td><td>${row.elapsedMs === undefined ? 'missing' : escape(`${row.elapsedMs} ms`)}</td><td>${escape(comparison.differences.find(diff => diff.studyId === row.studyId)?.changes.map(change => change.path).join(', ') || 'baseline')}</td></tr>`).join('');
  const changesHtml = comparison.differences.flatMap(diff => diff.changes.map(change => `<li>${escape(comparison.rows.find(row => row.studyId === diff.studyId)?.name ?? diff.studyId)} — ${escape(change.path)}: ${change.baselinePresent ? escape(JSON.stringify(change.baseline)) : 'missing'} → ${change.valuePresent ? escape(JSON.stringify(change.value)) : 'missing'}</li>`)).join('');
  const quantityHtml = comparison.quantities.map(quantity => `<tr><td>${escape(`${quantity.definition.kind} ${quantity.definition.field}/${quantity.definition.component} · ${quantity.definition.region} · t=${quantity.definition.time} · ${quantity.definition.reduction}`)}</td><td>${escape(quantity.compatible ? quantity.unit : 'incompatible units')}</td><td>${quantity.values.map(value => `<div>${escape(comparison.rows.find(row => row.studyId === value.studyId)?.name ?? value.studyId)}: ${escape(value.value ?? 'missing')}${value.unit ? ` ${escape(value.unit)}` : ''}</div>`).join('')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Variant comparison — ${escape(comparison.parentName)}</title><style>body{font:15px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #bbb;padding:.45rem;text-align:left;overflow-wrap:anywhere}li{margin:.3rem 0}</style><h1>Variant comparison: ${escape(comparison.parentName)}</h1><p>Study type: ${escape(comparison.classification)}</p><h2>Runs</h2><table><thead><tr><th>Study</th><th>Process</th><th>Variation</th><th>Convergence</th><th>Elapsed</th><th>Input differences</th></tr></thead><tbody>${rowHtml}</tbody></table><h2>Setting changes</h2><ul>${changesHtml || '<li>No setting changes</li>'}</ul><h2>Compatible scalar quantities</h2><table><thead><tr><th>Definition</th><th>Unit</th><th>Values by row</th></tr></thead><tbody>${quantityHtml || '<tr><td colspan="3">No selected quantities</td></tr>'}</tbody></table><ul>${comparison.findings.map(finding => `<li>${escape(finding)}</li>`).join('')}</ul></html>`;
}
