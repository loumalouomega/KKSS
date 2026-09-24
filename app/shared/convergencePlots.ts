/** Browser-safe plots used by Home and the self-contained review export. */
interface Sample { iteration: number; time?: number; converged: boolean | null; residual?: number; criterion?: string }
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function convergencePlots(samples: Sample[]): string {
  if (!samples.length) return '<p>Convergence history is unavailable.</p>';
  const chart = (values: (number | undefined)[], label: string): string => {
    const finite = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
    if (!finite.length) return `<p>${escape(label)}: unavailable.</p>`;
    const min = Math.min(...finite), max = Math.max(...finite);
    const x = (i: number) => values.length === 1 ? 480 : 60 + 840 * i / (values.length - 1);
    const y = (v: number) => max === min ? 80 : 125 - 90 * (v - min) / (max - min);
    const marks = values.map((v, i) => {
      if (v === undefined || !Number.isFinite(v)) return '';
      const previous = values[i - 1];
      const line = previous !== undefined && Number.isFinite(previous) ? `<line x1="${x(i - 1)}" y1="${y(previous)}" x2="${x(i)}" y2="${y(v)}" stroke="currentColor"/>` : '';
      return `${line}<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="currentColor"><title>${escape(`Step ${samples[i].iteration}, time ${samples[i].time ?? 'unavailable'}: ${v}`)}</title></circle>`;
    }).join('');
    return `<figure><figcaption>${escape(label)}</figcaption><svg role="img" aria-label="${escape(label)}" viewBox="0 0 960 160" style="width:100%;max-width:960px"><text x="5" y="20" fill="currentColor">${min.toExponential(3)} – ${max.toExponential(3)}</text>${marks}<text x="60" y="155" fill="currentColor">Recorded solution steps; missing values leave gaps</text></svg></figure>`;
  };
  const criteria = new Set(samples.filter(s => s.residual !== undefined).map(s => s.criterion ?? 'undeclared'));
  return chart(samples.map(s => s.converged === null ? undefined : Number(s.converged)), 'Solve-step outcomes (1 converged, 0 unconverged)') +
    (criteria.size > 1 ? '<p>Residual plot unavailable: recorded criteria differ.</p>' :
      chart(samples.map(s => s.residual), `Solver-reported residual norm (${[...criteria][0] ?? 'criterion unavailable'}; units undeclared)`));
}
