export function median(values: number[]): number;
export function regressions(current: Record<string, number>, baseline: Record<string, number>): string[];
export function exitCodeForRegressions(flagged: string[], strict: boolean): number;
export function sample(events: Array<{ event: string; file?: string; type?: string; end?: number; ms?: number }>, kind: string, file: string | undefined, started: number): number;
