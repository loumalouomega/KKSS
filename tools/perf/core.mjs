export function median(values) {
  if (!values.length || values.some(v => !Number.isFinite(v) || v <= 0)) throw new Error('Invalid timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}
export function regressions(current, baseline) {
  return Object.entries(current).filter(([key, ms]) => {
    if (!(baseline[key] > 0)) throw new Error(`Missing baseline: ${key}`);
    return ms > baseline[key] * 3;
  }).map(([key]) => key);
}
export function exitCodeForRegressions(flagged, strict) {
  return strict && flagged.length ? 1 : 0;
}
export function sample(events, kind, file, started) {
  const matches = events.filter(e => kind === 'launch' ? e.event === 'interactive' : e.event === 'open' && e.file === file && e.type === kind);
  if (matches.length !== 1) throw new Error(`Expected one correlated ${kind} marker, received ${matches.length}`);
  const value = kind === 'launch' ? matches[0].end - started : matches[0].ms;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid marker duration');
  return value;
}
