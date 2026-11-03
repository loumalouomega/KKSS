// Goal-seek (roadmap item 8), pure half: the next parameter value from the
// terminal, succeeded iterates only. An uncertain or failed iterate stops the
// loop; a value is never interpolated between runs and reported as solved.
export interface Iterate { x: number; y: number | null; state: 'succeeded' | 'failed' | 'uncertain' | 'cancelled' }
export interface SeekSpec { target: number; relTolerance: number; lower: number; upper: number; maxStep: number; maxSolves: number; initialStep: number; start?: number }
export type SeekDecision =
  | { kind: 'reached'; x: number; y: number }
  | { kind: 'next'; x: number }
  | { kind: 'stopped'; reason: string }
  | { kind: 'notReached'; reason: string };

export function validateSpec(s: SeekSpec): void {
  const finite = (s.start === undefined || Number.isFinite(s.start)) && [s.target, s.relTolerance, s.lower, s.upper, s.maxStep, s.initialStep].every(Number.isFinite);
  if (!finite || !(s.lower < s.upper) || !(s.maxStep > 0) || !(s.relTolerance > 0) || !(s.initialStep !== 0) || !Number.isSafeInteger(s.maxSolves) || s.maxSolves < 2) throw new Error('Goal-seek needs finite bounds, a positive maximum step and tolerance, a non-zero initial step and at least two solves.');
}

const clamp = (x: number, s: SeekSpec) => Math.min(s.upper, Math.max(s.lower, x));

export function nextIterate(history: Iterate[], s: SeekSpec): SeekDecision {
  validateSpec(s);
  const bad = history.find(h => h.state !== 'succeeded' || h.y === null || !Number.isFinite(h.y));
  if (bad) return { kind: 'stopped', reason: `Iterate at ${bad.x} ended ${bad.state === 'succeeded' ? 'without a finite value' : bad.state}; the loop does not continue from it.` };
  const last = history[history.length - 1];
  if (last) {
    const scale = Math.max(Math.abs(s.target), Number.MIN_VALUE);
    if (Math.abs(last.y! - s.target) / scale <= s.relTolerance) return { kind: 'reached', x: last.x, y: last.y! };
  }
  if (history.length >= s.maxSolves) return { kind: 'notReached', reason: `Not reached within ${s.maxSolves} solves.` };
  if (!history.length) return { kind: 'next', x: clamp(s.start ?? s.lower + (s.upper - s.lower) / 2, s) };
  let step: number;
  if (history.length === 1) step = s.initialStep;
  else {
    const a = history[history.length - 2], b = last;
    const slope = (b.y! - a.y!) / (b.x - a.x);
    // Secant only while the slope is finite and positive; otherwise fall back to the signed initial step.
    step = Number.isFinite(slope) && slope > 0 ? (s.target - b.y!) / slope : Math.sign(s.target - b.y!) * Math.abs(s.initialStep);
  }
  step = Math.sign(step) * Math.min(Math.abs(step), s.maxStep);
  const x = clamp(last.x + step, s);
  if (history.some(h => h.x === x)) return { kind: 'notReached', reason: `The next value ${x} was already solved (a bound or the step limit is binding).` };
  return { kind: 'next', x };
}
